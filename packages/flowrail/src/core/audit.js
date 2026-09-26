// flowrail audit: replay this project's recent Claude Code transcripts through the current red lines.
// Read-only and local: it parses only the tool_use blocks (name + input) in memory, calls no model,
// and writes nothing. Claude Code keeps one JSONL file per session under
// <config dir>/projects/<project path with every non-alphanumeric character as "-">/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { paths } from './paths.js';
import { readJson } from './util.js';
// The guard's own rules engine, so the replay decides exactly what the hook would (floor included).
import { loadForHook, decide, redact, relativize, workspaces, guardPaths } from '../guard/rules.js';
import { portRange, globToRegex } from '../guard/builtins.js';
import { normalize } from '../guard/shell.js';
import { permissionRules } from './recipes.js';
import { oursOnly } from './hooks.js';

const MAX_FILE = 256 * 1024 * 1024; // transcripts over 256 MB are skipped (they are read whole)

/** Where Claude Code keeps transcripts: $CLAUDE_CONFIG_DIR/projects, else ~/.claude/projects. */
export function transcriptsDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
}

export const encodeProject = (dir) => dir.replace(/[^a-zA-Z0-9]/g, '-');

function rootForms(root) {
  const forms = new Set([path.resolve(root)]);
  try { forms.add(fs.realpathSync(root)); } catch { /* keep the resolved form */ }
  return [...forms];
}

/** The project's folder plus folders for sessions started in its subfolders. */
function projectDirs(base, roots) {
  let names = [];
  try { names = fs.readdirSync(base); } catch { return []; }
  const encs = roots.map(encodeProject);
  return names.filter((n) => encs.some((e) => n === e || n.startsWith(e + '-'))).map((n) => path.join(base, n));
}

function jsonlFiles(dir, sinceMs, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { jsonlFiles(abs, sinceMs, out); continue; }
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    try {
      const st = fs.statSync(abs);
      if (st.mtimeMs >= sinceMs && st.size <= MAX_FILE) out.push(abs);
    } catch { /* gone since readdir */ }
  }
  return out;
}

const inside = (cwd, roots) => typeof cwd === 'string' && roots.some((r) => cwd === r || cwd.startsWith(r + path.sep));

/** Every tool call in one transcript file after `sinceMs`, deduplicated by tool_use id. */
function toolCalls(file, sinceMs, roots, seen) {
  const calls = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return calls; }
  for (const line of text.split('\n')) {
    if (!line.includes('"tool_use"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
    const at = Date.parse(o.timestamp);
    if (!(at >= sinceMs) || !inside(o.cwd, roots)) continue;
    for (const b of o.message.content) {
      if (!b || b.type !== 'tool_use' || typeof b.name !== 'string') continue;
      if (b.id && seen.has(b.id)) continue;
      if (b.id) seen.add(b.id);
      calls.push({ at: new Date(at).toISOString(), tool: b.name, input: b.input && typeof b.input === 'object' ? b.input : {}, cwd: o.cwd, session: String(o.sessionId || path.basename(file, '.jsonl')) });
    }
  }
  return calls;
}

// ---------- what Claude Code's own settings would have caught ----------

/**
 * permissions.deny/ask from the project's .claude/settings*.json and the user's settings.json,
 * and how many PreToolUse hooks of your own they run (not replayed: they are your scripts).
 */
export function settingsRules(root, env = process.env) {
  const user = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
  const files = [['.claude/settings.json', path.join(root, '.claude', 'settings.json')],
    ['.claude/settings.local.json', path.join(root, '.claude', 'settings.local.json')],
    ['~/.claude/settings.json', user]];
  const list = [];
  let hooks = 0;
  for (const [file, abs] of files) {
    let settings = null;
    try { settings = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
    list.push({ file, settings });
    const pre = settings && settings.hooks && settings.hooks.PreToolUse;
    hooks += Array.isArray(pre) ? pre.filter((g) => !oursOnly(g)).length : 0;
  }
  return { perms: permissionRules(list), hooks };
}

const FILE_EDITS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** Does one Claude Code permission rule (Bash(git push:*), Read(./.env), mcp__x) match a call? */
export function permissionMatches(rule, tool, input, root) {
  const m = /^([\w*.-]+)(?:\((.*)\))?$/s.exec(String(rule).trim());
  if (!m) return false;
  const [, name, spec] = m;
  if (name.startsWith('mcp__')) {
    const re = new RegExp(`^${name.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}(__.*)?$`);
    return re.test(tool);
  }
  if (name !== tool && !(name === 'Edit' && FILE_EDITS.includes(tool))) return false;
  if (spec === undefined || spec === '*' || spec === '') return true;
  if (tool === 'Bash') {
    const raw = String(input.command || '').trim();
    const cmds = [raw, ...normalize(raw)];
    const prefix = spec.endsWith(':*') || spec.endsWith(' *') ? spec.slice(0, -2) : null;
    if (prefix !== null && !prefix.includes('*')) {
      return cmds.some((c) => c === prefix || c.startsWith(prefix + ' '));
    }
    const wild = new RegExp(`^${spec.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
    return cmds.some((c) => wild.test(c));
  }
  const file = input.file_path || input.notebook_path || input.path;
  if (typeof file !== 'string') return false;
  const abs = path.resolve(root, file).split(path.sep).join('/');
  const home = os.homedir().split(path.sep).join('/');
  let pat = spec;
  if (pat.startsWith('//')) pat = pat.slice(1);
  else if (pat.startsWith('~/')) pat = `${home}/${pat.slice(2)}`;
  else if (pat.startsWith('/')) pat = `${root.split(path.sep).join('/')}${pat}`;
  else pat = pat.includes('/') && !pat.startsWith('**/')
    ? `${root.split(path.sep).join('/')}/${pat.replace(/^\.\//, '')}` : `**/${pat}`;
  const re = globToRegex(pat.startsWith('**/') ? pat : pat.replace(/\/$/, '/**'));
  return re.test(pat.startsWith('**/') ? abs.replace(/^\//, '') : abs) || re.test(`${abs}/x`);
}

/** 'deny', 'ask' or null: what Claude Code's permissions alone would have done with a call. */
export function settingsDecision(perms, tool, input, root) {
  for (const kind of ['deny', 'ask']) {
    if (perms.some((p) => p.kind === kind && permissionMatches(p.rule, tool, input, root))) return kind;
  }
  return null;
}

/**
 * @param {string} root workspace root
 * @param {{days?:number, env?:object, now?:number}} [opts]
 * @returns {{days:number, sessions:number, calls:number, held:object[], asked:object[], byLine:Object<string,number>, transcriptsDir:string, note?:string}}
 */
export function auditSummary(root, { days = 30, env = process.env, now = Date.now(), lines: given, settings: vs = true, settingsFrom } = {}) {
  days = Math.min(365, Math.max(1, Math.floor(Number(days)) || 30));
  const p = paths(root);
  const dir = transcriptsDir(env);
  const result = { days, sessions: 0, calls: 0, held: [], asked: [], byLine: {}, transcriptsDir: dir };
  const own = vs ? settingsRules(settingsFrom || root, env) : null;
  const { lines, error } = given ? { lines: given, error: null } : loadForHook(p);
  if (error) return { ...result, note: `flowrail/red-lines.json could not be read (${error}), so there is nothing to replay against.` };
  const roots = rootForms(root);
  const dirs = projectDirs(dir, roots);
  if (!dirs.length) return { ...result, note: `No Claude Code transcripts for this project in ${dir}.` };
  const sinceMs = now - days * 86400000;
  const seen = new Set();
  const sessions = new Set();
  let port = 4747;
  try { port = Number(readJson(p.config, {}).port) || 4747; } catch { /* default port */ }
  const ports = portRange(port);
  // Like the hook: the project's red lines plus those of any nested workspace on the way to the cwd.
  const linesCache = new Map();
  const linesFor = (cwd) => {
    if (given) return given;
    const { roots: ws } = workspaces({ projectDir: root, cwd });
    const key = ws.join('\0');
    if (!linesCache.has(key)) linesCache.set(key, ws.flatMap((w) => (w === root ? lines : loadForHook(guardPaths(w)).lines)));
    return linesCache.get(key);
  };
  for (const d of dirs) {
    for (const file of jsonlFiles(d, sinceMs)) {
      for (const call of toolCalls(file, sinceMs, roots, seen)) {
        result.calls++;
        sessions.add(call.session);
        let r;
        try { r = decide(linesFor(call.cwd), call.tool, call.input, { root, cwd: call.cwd, ports }); } catch { continue; }
        if (r.decision !== 'deny' && r.decision !== 'ask') continue;
        const id = r.line?.id || 'unknown';
        result.byLine[id] = (result.byLine[id] || 0) + 1;
        const list = r.decision === 'deny' ? result.held : result.asked;
        const caught = own ? settingsDecision(own.perms, call.tool, call.input, root) : null;
        list.push({ at: call.at, tool: call.tool, subject: redact(relativize(String(r.subject || ''), root)).slice(0, 200), line: id, severity: r.decision === 'deny' ? 'block' : 'ask', session: call.session.slice(0, 8), ...(caught ? { settings: caught } : {}) });
      }
    }
  }
  result.sessions = sessions.size;
  if (own) {
    const all = [...result.held, ...result.asked];
    const caught = all.filter((e) => e.settings).length;
    result.vsSettings = { rules: own.perms.length, hooks: own.hooks, caught, added: all.length - caught };
  }
  for (const list of [result.held, result.asked]) list.sort((a, b) => b.at.localeCompare(a.at));
  if (!result.calls) result.note = `No tool calls in the last ${days} days in ${dir}.`;
  return result;
}
