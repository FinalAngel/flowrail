// Claude Code hooks: the vendored guard, the .claude/settings.json installer, and the one truth
// about whether the guard is live. The runtime handlers live in src/guard/hook.mjs.
//
// `flowrail init` copies src/guard/ into the project as .claude/flowrail/guard/ with a manifest of
// sha256 hashes. The hooks in .claude/settings.json run a short inline check with plain node
// (`node -e '<check>' pre-tool-use`): it hashes manifest.json against the hash written into the
// command itself, hashes every guard file against the manifest, and only then imports hook.mjs.
// A guard file that is missing, emptied, edited or garbled, a manifest that was rewritten, or no
// node on PATH makes the PreToolUse command exit 2, and Claude Code blocks the call. The check
// needs no npm install and works in a fresh clone.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, writeText } from './util.js';
import { VERSION } from './workspace.js';
import { paths } from './paths.js';
import { driftStatus } from './redlines.js';

export { preToolUse, preToolUseCrashed, sessionStart, subagent, readStdin } from '../guard/hook.mjs';

export const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'flowrail.js');
export const GUARD_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'guard');
export const GUARD_REL = '.claude/flowrail/guard';
/**
 * Every file of the guard runtime, as posix paths relative to src/guard/ (builtins/git.js).
 * They import node: builtins and each other, nothing else.
 */
export const GUARD_FILES = (function walk(dir, pre = '') {
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${pre}${e.name}/`)
      : /\.m?js$/.test(e.name) ? [`${pre}${e.name}`] : []))
    .sort();
}(GUARD_SRC));

/** How humans call flowrail. The guard itself never needs it. */
export const cliName = () => 'npx flowrail';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Code files in the vendored guard folder, recursively (manifest.json left out). */
function listCode(dir, pre = '') {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? listCode(path.join(dir, e.name), `${pre}${e.name}/`)
    : /\.(m?js|cjs|json|node)$/.test(e.name) && `${pre}${e.name}` !== 'manifest.json' ? [`${pre}${e.name}`] : []));
}

/** The guard as shipped in this package: { files: {name: text}, manifest }. */
export function packagedGuard() {
  const files = {};
  for (const f of GUARD_FILES) files[f] = fs.readFileSync(path.join(GUARD_SRC, f), 'utf8');
  const manifest = { version: VERSION, files: Object.fromEntries(GUARD_FILES.map((f) => [f, sha256(files[f])])) };
  return { files, manifest, manifestText: JSON.stringify(manifest, null, 2) + '\n' };
}

/** Plan changes that make .claude/flowrail/guard/ exactly the packaged guard. */
export function planGuard(root) {
  const { files, manifestText } = packagedGuard();
  const want = { ...files, 'manifest.json': manifestText };
  const changes = [];
  for (const [name, text] of Object.entries(want)) {
    const rel = `${GUARD_REL}/${name}`;
    let before = null;
    try { before = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { /* new */ }
    if (before !== text) changes.push({ path: rel, kind: before === null ? 'add' : 'change', internal: true, before: before ?? '', after: text });
  }
  return changes;
}

/** Write the packaged guard into `root` now (the demo uses this). */
export function vendorGuard(root) {
  for (const c of planGuard(root)) writeText(path.join(root, c.path), c.after);
}

/**
 * Verify .claude/flowrail/guard/ against its manifest and against the hashes this package ships.
 * @returns {{version: string|null, verified: boolean, changed: string[], problem?: string}}
 */
export function guardStatus(root) {
  const dir = path.join(root, GUARD_REL);
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch (e) {
    if (e.code === 'ENOENT' && !fs.existsSync(dir)) return { version: null, verified: false, changed: [], problem: 'The guard is not in this project (.claude/flowrail/guard/ is missing). Run npx flowrail upgrade' };
    return { version: null, verified: false, changed: ['manifest.json'], problem: 'Guard files changed (manifest.json). Run npx flowrail upgrade to restore' };
  }
  const listed = manifest && typeof manifest.files === 'object' && manifest.files ? manifest.files : {};
  const changed = [];
  const shipped = packagedGuard().manifest;
  for (const f of new Set([...GUARD_FILES, ...Object.keys(listed)])) {
    let hash = null;
    try { hash = sha256(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* missing */ }
    if (!hash || hash !== listed[f] || (manifest.version === VERSION && hash !== shipped.files[f])) changed.push(f);
  }
  const extra = listCode(dir).filter((n) => !GUARD_FILES.includes(n) && !(n in listed));
  changed.push(...extra);
  const version = typeof manifest.version === 'string' ? manifest.version : null;
  if (changed.length) return { version, verified: false, changed, problem: `Guard files changed (${changed.join(', ')}). Run npx flowrail upgrade to restore` };
  if (version !== VERSION) return { version, verified: false, changed, problem: `The guard is version ${version || 'unknown'} and this flowrail is ${VERSION}, so its files cannot be verified. Run npx flowrail upgrade` };
  return { version, verified: true, changed };
}

// ---------- settings.json installer ----------

/**
 * The tools the PreToolUse hook sees: the ones that act (Bash, file writes, MCP tools) and the ones
 * that read files (Read, Grep: secret files still ask). Glob, WebFetch, Task and the rest never
 * start node.
 */
export const PRE_TOOL_MATCHER = 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|mcp__.*';

export const HOOK_EVENTS = [
  { event: 'PreToolUse', kind: 'pre-tool-use', matcher: PRE_TOOL_MATCHER },
  { event: 'SessionStart', kind: 'session-start' },
  { event: 'SubagentStart', kind: 'subagent' },
  { event: 'SubagentStop', kind: 'subagent' },
];

const MARK = '/*flowrail-guard*/';
const FAILED = 'flowrail: the guard did not run, so this call is blocked. .claude/flowrail/guard/ is '
  + 'missing or does not match its manifest, or node is not on PATH. Restore it: npx flowrail upgrade';

/** sha256 of the manifest the vendored guard ships with: pinned into every hook command. */
export const manifestHash = (text = packagedGuard().manifestText) => sha256(text);

/**
 * The inline integrity check. No single quotes (it sits in a single-quoted shell word). Exit 3 on
 * any mismatch; a failed import is an uncaught rejection (exit 1). Both end in the `|| exit 2`.
 */
const shim = (hash) => `${MARK}const f=require("fs"),h=b=>require("crypto").createHash("sha256")`
  + '.update(b).digest("hex"),d=process.env.CLAUDE_PROJECT_DIR+"/.claude/flowrail/guard/";'
  + `try{const m=f.readFileSync(d+"manifest.json");if(h(m)!=="${hash}")throw 0;`
  + 'for(const[k,v]of Object.entries(JSON.parse(m).files))if(h(f.readFileSync(d+k))!==v)throw 0}'
  + 'catch{process.exit(3)}import(require("url").pathToFileURL(d+"hook.mjs"))'
  + '.then(g=>g.main(process.argv[1]))';

/**
 * The command for one hook, pinned to one manifest. pre-tool-use fails closed: a guard that does
 * not verify, a missing guard or a missing node exits 2 and Claude Code blocks the call.
 */
export function hookCommand(kind, hash = manifestHash()) {
  const cmd = `node -e '${shim(hash)}' ${kind}`;
  return kind === 'pre-tool-use' ? `${cmd} || { echo '${FAILED}' >&2; exit 2; }` : cmd;
}

/** The plan preview's one-line description of a hook command. */
export const hookSummary = (kind) => `node: verify .claude/flowrail/guard/ against its manifest, `
  + `then run hook.mjs ${kind}${kind === 'pre-tool-use' ? ' (exit 2 if it cannot)' : ''}`;

// Ours, old and new: `... flowrail hook <kind>`, `flowrail guard`, `.../flowrail/guard/hook.mjs <kind>`,
// and the inline check `node -e '/*flowrail-guard*/...' <kind>`.
const OURS = new RegExp('flowrail(?:\\.js)?["\']?\\s+(?:hook\\s+([a-z-]+)|(guard)\\b)'
  + '|flowrail\\/guard\\/hook\\.mjs["\']?\\s+([a-z-]+)|\\/\\*flowrail-guard\\*\\/[^\']*\'\\s+([a-z-]+)');
const kindOf = (m) => m[1] || m[3] || m[4] || 'pre-tool-use';
const vendored = (cmd) => /flowrail\/guard\/hook\.mjs|\/\*flowrail-guard\*\//.test(cmd);
/** Is this group ours alone (every hook in it is a flowrail hook)? */
export const oursOnly = (g) => Array.isArray(g && g.hooks) && g.hooks.length > 0
  && g.hooks.every((h) => OURS.test((h && h.command) || ''));

/** Returns a new settings object with flowrail hooks present and current. Never touches other hooks. */
export function mergeHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};
  const changed = [];
  for (const { event, kind, matcher } of HOOK_EVENTS) {
    const groups = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const want = hookCommand(kind);
    let found = false;
    for (const g of groups) {
      for (const h of g.hooks || []) {
        const m = OURS.exec(h.command || '');
        if (m && kindOf(m) === kind) {
          found = true;
          if (h.command !== want) { h.command = want; changed.push(event); }
          if (matcher && g.matcher !== matcher && oursOnly(g)) { g.matcher = matcher; changed.push(event); }
        }
      }
    }
    if (!found) {
      groups.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: want, timeout: 10 }] });
      changed.push(event);
    }
    next.hooks[event] = groups;
  }
  return { settings: next, changed };
}

export function removeHooks(settings) {
  const next = JSON.parse(JSON.stringify(settings || {}));
  const removed = [];
  for (const event of Object.keys(next.hooks || {})) {
    const groups = (next.hooks[event] || []).map((g) => {
      const keep = (g.hooks || []).filter((h) => !OURS.test((h && h.command) || ''));
      if (keep.length !== (g.hooks || []).length) removed.push(event);
      return { ...g, hooks: keep };
    }).filter((g) => g.hooks.length);
    if (groups.length) next.hooks[event] = groups; else delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return { settings: next, removed: [...new Set(removed)] };
}

export function readSettings(p) {
  return readJson(p.settings, {});
}

export const localSettings = (p) => path.join(p.claudeDir, 'settings.local.json');

/**
 * The one truth about hook state, used by doctor, status, the API and the dashboard pill.
 *   installed  every flowrail hook event is present in .claude/settings.json (or settings.local.json)
 *   healthy    installed, the settings parse, every hook calls the vendored guard, and the guard's
 *              files match their manifest and the hashes this package ships
 *   where      the file holding the PreToolUse hook
 *   guard      { version, verified, changed: [file names] }
 *   problem    why it is not healthy (absent when healthy)
 * A red line with a hook is only "armed" when healthy.
 */
export function hooksStatus(p) {
  if (typeof p === 'string') p = paths(p);
  const events = {};
  const commands = [];
  const kinds = [];
  let where = null;
  let command = null;
  let problem = null;
  for (const [name, file] of [['settings.json', p.settings], ['settings.local.json', localSettings(p)]]) {
    let s;
    try { s = readJson(file, {}); } catch { problem = problem || `.claude/${name} is not valid JSON, so Claude Code ignores its hooks`; continue; }
    for (const { event, kind } of HOOK_EVENTS) {
      for (const g of (s && s.hooks && s.hooks[event]) || []) {
        for (const h of (g && g.hooks) || []) {
          const m = OURS.exec((h && h.command) || '');
          if (!m || kindOf(m) !== kind) continue;
          events[event] = true;
          commands.push(h.command);
          kinds.push(kind);
          if (event === 'PreToolUse' && !where) { where = name; command = h.command; }
        }
      }
    }
  }
  const installed = HOOK_EVENTS.every((e) => events[e.event]);
  if (!installed && !problem) {
    const missing = [...new Set(HOOK_EVENTS.filter((e) => !events[e.event]).map((e) => e.event))];
    problem = missing.length === HOOK_EVENTS.length ? 'The guard is not installed (no flowrail hooks in .claude/settings.json)' : `The guard's hooks are incomplete (missing ${missing.join(', ')})`;
  }
  if (installed && !problem && commands.some((c) => !vendored(c))) problem = 'Hooks still call flowrail through npm (the old setup). Run npx flowrail upgrade to switch to the vendored guard';
  const guard = guardStatus(p.root);
  if (!problem && !guard.verified) problem = guard.problem;
  // Every hook command must be the pinned check for the manifest on disk: an older command that
  // runs hook.mjs unchecked, or one edited by hand, does not fail closed.
  let onDisk = null;
  try { onDisk = fs.readFileSync(path.join(p.root, GUARD_REL, 'manifest.json'), 'utf8'); } catch { /* guardStatus says */ }
  if (installed && !problem && onDisk !== null && commands.some((c, i) => c !== hookCommand(kinds[i], manifestHash(onDisk)))) {
    problem = 'The hook commands in .claude/settings.json do not verify the guard before running it (an older setup, or edited by hand). Run npx flowrail upgrade';
  }
  const healthy = installed && !problem;
  // Rules changed outside flowrail: the guard still holds (it asks on every call), so this is not
  // "unhealthy", but doctor, status and the dashboard say it.
  const drift = driftStatus(p.root);
  return {
    installed, healthy, where, command,
    guard: { version: guard.version, verified: guard.verified, changed: guard.changed },
    ...(healthy ? {} : { problem }), preToolUse: !!events.PreToolUse, events, commands, drift,
  };
}

/** The dashboard/API shape of hooksStatus. */
export const hooksSummary = (hs) => ({
  installed: hs.installed, healthy: hs.healthy, where: hs.where, command: hs.command, guard: hs.guard,
  ...(hs.problem ? { problem: hs.problem } : {}),
});

export function writeSettings(p, settings, file = 'settings.json') {
  writeJson(path.join(p.claudeDir, file), settings);
}
