// Red lines: everything the dashboard and CLI need on top of the guard's runtime (src/guard/rules.js):
// the change log, stats, file checks and per-line state.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, readJsonl, nowIso } from './util.js';
import { toPosix } from './paths.js';
import { hasHook, FLOOR, RANK, record } from '../guard/rules.js';
import { findSecret, globToRegex } from '../guard/builtins.js';
import { acceptChange, acceptRules, rulesDrift, readAccepted, WATCHED, watchedPath } from '../guard/state.js';

export { acceptRules, readAccepted, WATCHED, watchedPath };

/**
 * Red lines or config changed outside flowrail: { changed, files: ['flowrail/red-lines.json'] }.
 * Takes a workspace root or its paths object. Reading it never accepts anything, except the
 * first time a project is seen on this machine (see rulesDrift).
 */
export function driftStatus(rootOrPaths) {
  const root = typeof rootOrPaths === 'string' ? rootOrPaths : rootOrPaths.root;
  let files = [];
  try { files = rulesDrift(root); } catch { /* no state dir: nothing to compare with */ }
  return { changed: files.length > 0, files };
}
export const drift = driftStatus;
export { verifyRedlines } from './verify.js';

export { SEVERITIES, FLOOR, loadForHook, validateLines, toolMatches, subjectOf, decide, reasonFor, summaryOf, redact, relativize, logEvent, workspaces, hookProblem } from '../guard/rules.js';
export { globToRegex } from '../guard/builtins.js';
import { summaryOf, redact, relativize } from '../guard/rules.js';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Read']);

export function loadLines(p) {
  const lines = readJson(p.redlines, []);
  return Array.isArray(lines) ? lines : [];
}

/**
 * Does `after` only add or tighten red lines compared to `before`? Returns the reasons it weakens
 * (empty = only additions and tightenings). Weakening: a line removed, its severity lowered, its
 * hook or check changed or removed. New lines, a higher severity, and a hook or check added to a
 * line that had none are fine.
 */
export function weakenings(before, after) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const next = new Map((Array.isArray(after) ? after : []).map((l) => [l && l.id, l]));
  const out = [];
  for (const b of Array.isArray(before) ? before : []) {
    if (!b || !b.id) continue;
    const a = next.get(b.id);
    if (!a) { out.push(`${b.id} is removed`); continue; }
    if ((RANK[a.severity] || 0) < (RANK[b.severity] || 0)) out.push(`${b.id}: severity ${b.severity} -> ${a.severity}`);
    if (b.hook && !same(a.hook, b.hook)) out.push(`${b.id}: its hook changes`);
    if (b.check && !same(a.check, b.check)) out.push(`${b.id}: its check changes`);
  }
  return out;
}

/** Record a change to red-lines.json made through the dashboard API. */
export function logChange(p, before, after, by = 'dashboard') {
  const ids = (ls) => new Map((Array.isArray(ls) ? ls : []).map((l) => [l && l.id, JSON.stringify(l)]));
  const a = ids(before);
  const b = ids(after);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && a.get(k) !== b.get(k));
  const entry = { at: nowIso(), decision: 'changed', by, added, removed, changed };
  record(p, entry);
  // flowrail made this change: accept it, so the guard does not treat it as drift. A change on top
  // of drift is not accepted: the human still reviews the drift with `flowrail redlines accept`.
  try { acceptChange(p.root, 'red-lines.json', Array.isArray(before) ? before : null, by); } catch { /* read-only */ }
  return entry;
}

/** "3 removed, 1 added" */
export function changeText(e) {
  const bits = [];
  if (e.removed?.length) bits.push(`${e.removed.length} removed`);
  if (e.added?.length) bits.push(`${e.added.length} added`);
  if (e.changed?.length) bits.push(`${e.changed.length} changed`);
  return bits.join(', ') || 'no change';
}

export function readEvents(p) {
  return readJsonl(p.redlinesLog);
}

/** Holds only (no probes, no config changes), with paths relative and commands redacted. */
export function holds(p) {
  return readEvents(p).filter((e) => e.decision !== 'changed' && !e.probe).map((e) => {
    const subject = redact(relativize(e.subject || '', p.root));
    return { ...e, subject, ...(FILE_TOOLS.has(e.tool) || e.tool === 'Grep' ? { path: subject } : {}) };
  });
}

export const changes = (p) => readEvents(p).filter((e) => e.decision === 'changed');

/** held7d counts block and ask decisions in the last seven days; probes do not count. */
export function stats(p, now = Date.now()) {
  const week = now - 7 * 86400000;
  const byId = {};
  let held7d = 0;
  let probes7d = 0;
  for (const e of readEvents(p)) {
    if (e.decision === 'changed' || new Date(e.at).getTime() < week || e.severity === 'warn') continue;
    if (e.probe) { probes7d++; continue; }
    held7d++;
    byId[e.id] = (byId[e.id] || 0) + 1;
  }
  return { held7d, byId, probes7d };
}

// ---------- file checks ----------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.flowrail', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor']);
const MAX_FILE = 1024 * 1024;

export function walkFiles(root, { limit = 20000, skipDirs = SKIP_DIRS } = {}) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries;
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!skipDirs.has(e.name)) stack.push(r); }
      else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

function readTextFile(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.size > MAX_FILE) return null;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Run every red line's `check` over the repo.
 * @returns {{ results: object[], ranAt: string, files: number }}
 */
export function runChecks(p, lines = loadLines(p)) {
  const checks = lines.filter((l) => l.check && l.check.pattern).map((l) => {
    try {
      return { line: l, glob: globToRegex(l.check.glob || '**/*'), re: new RegExp(l.check.pattern, l.check.flags || '') };
    } catch { return null; }
  }).filter(Boolean);
  // secret-files also scans file contents for API keys and private keys (the same patterns the
  // hook checks on every Write and Edit).
  const secretLine = lines.find((l) => l.hook && l.hook.builtin === 'secret-files');
  if (secretLine) checks.push({ line: { ...secretLine, check: { message: 'secret in a file' } }, glob: /./, re: { test: (row) => !!findSecret(row) }, secret: true });
  const results = [];
  const files = checks.length ? walkFiles(p.root) : [];
  for (const rel of files) {
    const wanted = checks.filter((c) => c.glob.test(rel));
    if (!wanted.length) continue;
    const text = readTextFile(path.join(p.root, rel));
    if (text === null) continue;
    const rows = text.split('\n');
    // A file of test fixtures opts out of the secret scan (not of the hook) with this marker in its first five lines.
    const fixtures = rows.slice(0, 5).some((r) => r.includes('flowrail:allow-secrets'));
    for (const c of wanted) {
      if (fixtures && (c.secret || c.line.id === secretLine?.id)) continue;
      for (let i = 0; i < rows.length; i++) {
        if (!c.re.test(rows[i])) continue;
        if (c.secret && results.some((r) => r.id === c.line.id && r.file === toPosix(rel) && r.line === i + 1)) continue;
        const text = c.secret ? redact(rows[i].trim()).slice(0, 160) : rows[i].trim().slice(0, 160);
        results.push({ id: c.line.id, severity: c.line.severity, file: toPosix(rel), line: i + 1, text, message: c.secret ? `${findSecret(rows[i])} in the file` : c.line.check.message || c.line.title });
        if (results.length >= 500) break;
      }
    }
  }
  const out = { results, ranAt: nowIso(), files: files.length };
  try { writeJson(p.checkCache, out); } catch { /* read-only checkout is fine */ }
  return out;
}

export function cachedChecks(p) {
  return readJson(p.checkCache, { results: [], ranAt: null, files: 0 });
}

/**
 * Rule -> check -> hook chain per line, with its state. One truth for server, CLI and UI:
 *   armed        has a hook and the hooks are installed and healthy (held at runtime)
 *   not-enforced has a hook but the hooks are missing or broken (the only red state)
 *   checked      check only: enforced in CI by `flowrail check`, not at runtime
 *   declared     neither hook nor check
 */
export function stateOf(line, hooksHealthy) {
  if (hasHook(line)) return hooksHealthy ? 'armed' : 'not-enforced';
  return line.check && line.check.pattern ? 'checked' : 'declared';
}

/**
 * Every red line with its summary and state. protect-flowrail is the built-in floor: always active,
 * marked floor:true, and listed even when red-lines.json leaves it out.
 */
export function describe(lines, hooksHealthy) {
  const all = lines.some((l) => l && l.id === FLOOR.id) ? lines.map((l) => (l && l.id === FLOOR.id ? { ...l, floor: true } : l)) : [...lines, { ...FLOOR, hook: { ...FLOOR.hook } }];
  return all.map((l) => ({
    ...l,
    summary: summaryOf(l),
    builtin: (l.hook && l.hook.builtin) || null,
    links: { rule: true, check: !!(l.check && l.check.pattern), hook: hasHook(l) },
    state: stateOf(l, hooksHealthy),
  }));
}

/** { armed, checked, declared, 'not-enforced' } counts. */
export function stateCounts(lines, hooksHealthy) {
  const n = { armed: 0, checked: 0, declared: 0, 'not-enforced': 0 };
  for (const l of lines) n[stateOf(l, hooksHealthy)]++;
  return n;
}

export const STATE_LABEL = { armed: 'armed', checked: 'checked in CI', declared: 'declared only', 'not-enforced': 'not enforced' };

/** "3 armed, 1 checked in CI, 1 declared only" (zero counts left out). */
export function stateSummary(n) {
  return Object.keys(STATE_LABEL).filter((k) => n[k]).map((k) => `${n[k]} ${STATE_LABEL[k]}`).join(', ') || 'none';
}
