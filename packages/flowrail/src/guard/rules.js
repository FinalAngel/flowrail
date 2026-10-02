// Red lines at runtime: load, validate, find the workspaces, decide, log.
// Part of the vendored guard (.claude/flowrail/guard/): imports node: builtins and ./ files only.
import fs from 'node:fs';
import path from 'node:path';
import { commands, render } from './shell.js';
import { BUILTINS, BUILTIN_IDS, runBuiltin, portRange, toPosix } from './builtins.js';
import { appendJournal } from './state.js';

export const SEVERITIES = ['block', 'ask', 'warn'];
export const RANK = { block: 3, ask: 2, warn: 1 };
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read']);

/**
 * The built-in floor. Compiled into the guard and always active, whatever red-lines.json says:
 * the file can raise it to block, it cannot remove it or lower it.
 */
export const FLOOR = Object.freeze({
  id: 'protect-flowrail',
  title: 'Ask before changing the guardrails',
  why: 'Red lines, flowrail settings, the guard and the Claude Code hooks are the human\'s to '
    + 'change. An agent that edits them has switched off its own seatbelt.',
  severity: 'ask',
  hook: Object.freeze({ tool: '*', builtin: 'flowrail-tamper' }),
  floor: true,
});

/** Where the guard's files live inside a workspace. */
export function guardPaths(root) {
  const state = path.join(root, 'flowrail');
  const local = path.join(root, '.flowrail');
  return {
    root,
    config: path.join(state, 'config.json'),
    redlines: path.join(state, 'red-lines.json'),
    board: path.join(state, 'board.json'),
    comments: path.join(local, 'comments'),
    sharedComments: path.join(state, 'comments'),
    agents: path.join(local, 'agents'),
    redlinesLog: path.join(local, 'redlines.log'),
  };
}

const isWorkspace = (dir) => fs.existsSync(path.join(dir, 'flowrail', 'red-lines.json'))
  || fs.existsSync(path.join(dir, 'flowrail', 'config.json'));

function ancestors(start) {
  const out = [];
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    out.push(dir);
    if (path.dirname(dir) === dir) return out;
  }
}

/**
 * Every workspace whose red lines apply to a tool call, and the project root.
 * The project is CLAUDE_PROJECT_DIR (or the folder the vendored guard lives in); red lines come
 * from the project and from every flowrail workspace between it and the call's cwd, and above the
 * cwd too. A nested flowrail/ folder can add lines, never take any away.
 * @returns {{root: string|null, roots: string[]}}
 */
export function workspaces({ projectDir, cwd }) {
  const roots = [];
  // One spelling per folder, symlinks resolved: /var/folders/x and /private/var/folders/x are one.
  const real = (d) => {
    try { return fs.realpathSync(d); } catch { return path.resolve(d); }
  };
  const add = (d) => { if (d && !roots.includes(real(d))) roots.push(real(d)); };
  const pd = projectDir ? real(projectDir) : null;
  // A project with the vendored guard is guarded even when its red-lines.json is gone.
  const vendored = (d) => fs.existsSync(path.join(d, '.claude', 'flowrail', 'guard', 'hook.mjs'));
  const guarded = pd && (isWorkspace(pd) || vendored(pd));
  if (guarded) add(pd);
  const dirs = [...ancestors(cwd || pd || process.cwd()), ...(pd ? ancestors(pd) : [])];
  for (const dir of dirs) if (isWorkspace(dir)) add(dir);
  if (guarded) return { root: pd, roots };
  // Without a guarded project dir (a human piping JSON in), the outermost workspace is the project.
  return { root: roots.length ? roots[roots.length - 1] : null, roots };
}

/**
 * Load for enforcement. A missing, unreadable or non-array file is an error, never "no rules":
 * the hook turns it into an ask on every tool call (fail closed).
 * @returns {{lines: object[], error: string|null}}
 */
export function loadForHook(p) {
  let text;
  try {
    text = fs.readFileSync(p.redlines, 'utf8');
  } catch (e) {
    return { lines: [], error: e.code === 'ENOENT' ? 'the file is missing' : e.message };
  }
  let lines;
  try {
    lines = JSON.parse(text);
  } catch (e) {
    return { lines: [], error: `not valid JSON: ${e.message}` };
  }
  if (!Array.isArray(lines)) return { lines: [], error: 'it must be a JSON array' };
  return { lines, error: null };
}

export const hasHook = (l) => !!(l && l.hook && (l.hook.match || l.hook.builtin));

/** Returns a list of human-readable problems; empty means valid. */
export function validateLines(lines) {
  const errors = [];
  if (!Array.isArray(lines)) return ['red-lines.json must be a JSON array'];
  const ids = new Set();
  lines.forEach((l, i) => {
    const at = `red line ${i + 1}${l && l.id ? ` (${l.id})` : ''}`;
    if (!l || typeof l !== 'object') return errors.push(`${at}: must be an object`);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(l.id || '')) {
      errors.push(`${at}: id must be lowercase letters, digits and dashes`);
    }
    if (ids.has(l.id)) errors.push(`${at}: duplicate id`);
    ids.add(l.id);
    if (!l.title || typeof l.title !== 'string') errors.push(`${at}: title is required`);
    if (!SEVERITIES.includes(l.severity)) errors.push(`${at}: severity must be block, ask or warn`);
    if (l.hook) {
      const problem = hookProblem(l.hook);
      if (problem) errors.push(`${at}: ${problem}`);
    }
    if (l.check) {
      try {
        new RegExp(l.check.pattern, l.check.flags || '');
      } catch (e) {
        errors.push(`${at}: check.pattern does not compile: ${e.message}`);
      }
      if (typeof l.check.pattern !== 'string') errors.push(`${at}: check.pattern must be a string`);
      if (l.check.glob && typeof l.check.glob !== 'string') {
        errors.push(`${at}: check.glob must be a string`);
      }
    }
  });
  return errors;
}

/** Why a hook cannot be enforced, or null. */
export function hookProblem(hook) {
  if (!hook || typeof hook !== 'object') return 'hook must be an object';
  if (hook.tool !== undefined && (typeof hook.tool !== 'string' || !hook.tool)) {
    return 'hook.tool must be a tool name like "Bash" or "*"';
  }
  if (hook.builtin !== undefined) {
    const b = BUILTINS[hook.builtin];
    if (!b) {
      return `hook.builtin "${hook.builtin}" is unknown (use one of ${BUILTIN_IDS.join(', ')})`;
    }
    return b.params ? b.params(hook.params || {}) : null;
  }
  if (typeof hook.tool !== 'string') return 'hook.tool is required (e.g. "Bash" or "*")';
  if (typeof hook.match !== 'string') return 'hook needs "match" (a regex) or "builtin"';
  try {
    new RegExp(hook.match, hook.flags || '');
  } catch (e) {
    return `hook.match does not compile: ${e.message}`;
  }
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function toolMatches(pattern, name) {
  return String(pattern).split('|').some((p) => {
    p = p.trim();
    if (p === '*') return true;
    if (p.includes('*')) {
      return new RegExp('^' + p.split('*').map(escapeRe).join('.*') + '$', 'i').test(name);
    }
    return p === name;
  });
}

export function subjectOf(toolName, input = {}) {
  if (toolName === 'Bash') return String(input.command ?? '');
  if (FILE_TOOLS.has(toolName) || toolName === 'Grep') {
    return String(input.file_path ?? input.notebook_path ?? input.path ?? '');
  }
  try { return JSON.stringify(input ?? {}); } catch { return ''; }
}

const lower = (a, b) => (RANK[a] <= RANK[b] ? a : b);

/**
 * Decide what the hook should do with one tool call.
 * ctx: { root, roots, cwd, ports } so builtins can resolve paths (defaults: the process cwd).
 * The built-in floor (protect-flowrail) is always added; ctx.noFloor leaves it out (corpus probes).
 * A line whose hook is broken (bad regex, unknown builtin) asks on its tools: fail closed.
 * @returns {{decision:'deny'|'ask'|'warn'|'allow', line?:object, what?:string, broken?:string,
 *   subject:string, normalized:string[]}}
 */
export function decide(lines, toolName, toolInput, ctx = {}) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const subject = subjectOf(toolName, input);
  const cmds = toolName === 'Bash' ? commands(subject) : [];
  const normalized = cmds.map(render);
  const bctx = {
    tool: toolName, input, root: ctx.root, roots: ctx.roots, cwd: ctx.cwd || input.cwd,
    ports: ctx.ports || portRange(4747), cmds,
  };
  let best = null;
  const consider = (line, severity, extra = {}) => {
    if (!best || RANK[severity] > RANK[best.severity]) best = { line, severity, ...extra };
  };
  for (const line of ctx.noFloor ? lines : [...lines, FLOOR]) {
    const hook = line && line.hook;
    if (!hook || !RANK[line.severity]) continue;
    if (!toolMatches(hook.tool || '*', toolName)) continue;
    const problem = hookProblem(hook);
    if (problem) { consider(line, 'ask', { broken: problem }); continue; }
    if (hook.builtin) {
      const hit = runBuiltin(hook.builtin, { ...bctx, params: hook.params });
      if (hit) consider(line, lower(line.severity, hit.severity), { what: hit.what });
      continue;
    }
    const re = new RegExp(hook.match, hook.flags || '');
    const candidates = toolName === 'Bash' && !hook.raw ? normalized : [subject];
    if (candidates.some((c) => re.test(c))) consider(line, line.severity);
  }
  const decision = !best ? 'allow' : best.severity === 'block' ? 'deny' : best.severity;
  return {
    decision, line: best?.line, what: best?.what, broken: best?.broken, subject, normalized,
  };
}

export function reasonFor(line, extra = {}) {
  if (extra.broken) {
    return `flowrail: red line ${line.id} cannot be checked (${extra.broken}). `
      + 'Fix flowrail/red-lines.json or run npx flowrail doctor.';
  }
  const what = extra.what ? ` (${extra.what})` : '';
  return `flowrail red line ${line.id}: ${line.title}${what}.${line.why ? ' ' + line.why : ''}`;
}

/** Plain-English one-liner for a red line: what the builtin holds, else its why (or title). */
export function summaryOf(line) {
  const b = line.hook && BUILTINS[line.hook.builtin];
  if (b) return b.summary(line.severity, line.hook.params || {});
  return line.why || line.title || line.id;
}

// ---------- the hold log ----------

/** Hide credentials in a command before it is written to the log. */
const HEADER = new RegExp('\\b(authorization|x-api-key|api-key|cookie)(\\s*[:=]\\s*)'
  + '(bearer\\s+|basic\\s+|token\\s+)?[^\\s\'"&]+', 'gi');
const PARAM = new RegExp('([?&\\s-]{1,2}|\\b)((?:access_|api_|auth_|client_|refresh_)?'
  + '(?:token|key|secret|password|passwd|pwd|apikey|signature|sig))=([^&\\s\'"]+)', 'gi');
const TOKENS = new RegExp('\\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}'
  + '|sk-[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}'
  + '|AIza[0-9A-Za-z_-]{30,})\\b', 'g');
const LONG = /(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g;

export function redact(text) {
  return String(text)
    .replace(/(\w+:\/\/)[^/\s:@]+(:[^/\s@]*)?@/g, '$1***@')
    .replace(HEADER, '$1$2$3***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***')
    .replace(PARAM, '$1$2=***')
    .replace(TOKENS, '***')
    .replace(/\b[0-9a-f]{32,}\b/gi, '***')
    .replace(LONG, '***');
}

/** Show paths relative to the project: /abs/project/src/x -> src/x. */
export function relativize(text, root) {
  if (!root) return String(text);
  const r = toPosix(root).replace(/\/+$/, '');
  return String(text).split(r + '/').join('').split(r).join('.');
}

/** Append one entry to .flowrail/redlines.log and the same entry to the machine-local journal. */
export function record(p, entry) {
  fs.mkdirSync(path.dirname(p.redlinesLog), { recursive: true });
  fs.appendFileSync(p.redlinesLog, JSON.stringify(entry) + '\n');
  try {
    appendJournal(p.root, entry);
  } catch { /* the journal is best effort; doctor reports a gap */ }
}

/**
 * Log a hold. Calls without a session_id (a human piping JSON into the hook) are marked probe
 * and never count as holds.
 */
export function logEvent(p, entry) {
  const file = FILE_TOOLS.has(entry.tool) || entry.tool === 'Grep';
  const subject = redact(relativize(entry.subject, p.root)).slice(0, 200);
  record(p, {
    at: new Date().toISOString(),
    id: entry.line.id,
    severity: entry.line.severity,
    decision: entry.decision,
    tool: entry.tool,
    subject,
    ...(file ? { path: subject } : {}),
    ...(entry.what ? { what: entry.what } : {}),
    ...(entry.probe ? { probe: true } : {}),
  });
}
