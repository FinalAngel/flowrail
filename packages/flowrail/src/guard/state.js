// Machine-local state outside the repo: the hash-chained journal of every hook decision and
// red-lines change, the accepted snapshots of the rules, the key that signs comments written
// from the dashboard, and the ports a running dashboard listens on.
// The agent works inside the repo; this folder is not in it, so a trimmed .flowrail/redlines.log,
// a hand-written "human" comment or a red-lines.json replaced by `tar -x` shows up.
// Part of the vendored guard: node: imports only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Where flowrail keeps per-machine state. FLOWRAIL_STATE_DIR overrides it (tests). */
export function stateDir(env = process.env) {
  if (env.FLOWRAIL_STATE_DIR) return env.FLOWRAIL_STATE_DIR;
  if (env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'flowrail');
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'flowrail');
  }
  if (process.platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'flowrail');
  }
  return path.join(home, '.local', 'state', 'flowrail');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function realRoot(root) {
  try { return fs.realpathSync(root); } catch { return path.resolve(root); }
}

export const projectId = (root) => sha256(realRoot(root)).slice(0, 16);
export const journalPath = (root) => path.join(stateDir(), `${projectId(root)}.jsonl`);

/** The hash of the last journal line, read from the file's tail ('' for an empty journal). */
function lastHash(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return ''; }
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const h = JSON.parse(lines[i]).hash;
        if (typeof h === 'string') return h;
      } catch { /* torn line */ }
    }
    return '';
  } finally { fs.closeSync(fd); }
}

const chainHash = (prev, entry) => sha256(prev + JSON.stringify(entry));

/** Append {...entry, prev, hash}. hash = sha256(prev + JSON.stringify(entry)). */
export function appendJournal(root, entry) {
  const file = journalPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const prev = lastHash(file);
  const line = JSON.stringify({ ...entry, prev, hash: chainHash(prev, entry) });
  fs.appendFileSync(file, line + '\n', { mode: 0o600 });
}

/** Every journal entry, or [] when there is none yet. */
export function readJournal(root) {
  let text = '';
  try { text = fs.readFileSync(journalPath(root), 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ torn: line }); }
  }
  return out;
}

/** { ok, brokenAt }: brokenAt is the index of the first entry whose hash or prev link fails. */
export function verifyChain(entries) {
  let prev = '';
  for (let i = 0; i < entries.length; i++) {
    const { prev: p, hash, ...entry } = entries[i];
    if (p !== prev || hash !== chainHash(prev, entry)) return { ok: false, brokenAt: i };
    prev = hash;
  }
  return { ok: true, brokenAt: -1 };
}

/**
 * A folder path used before by another project (or an old clone of this one): its machine-local
 * state belongs to that one. Move the journal, the accepted snapshots and any pending edit aside
 * (<id>.<stamp>.old.*) and start a new journal epoch with one 'epoch' entry.
 * @returns {string[]} the files moved aside
 */
export function startEpoch(root, why = 'fresh setup') {
  const id = projectId(root);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const moved = [];
  for (const ext of ['jsonl', 'accepted.json', 'pending.json']) {
    const file = path.join(stateDir(), `${id}.${ext}`);
    if (!fs.existsSync(file)) continue;
    const to = path.join(stateDir(), `${id}.${stamp}.old.${ext}`);
    fs.renameSync(file, to);
    moved.push(to);
  }
  appendJournal(root, {
    at: new Date().toISOString(), decision: 'epoch', why,
    archived: moved.map((f) => path.basename(f)),
  });
  return moved;
}

/** Is there machine-local state for this path from before (a journal or accepted snapshots)? */
export const hasState = (root) => ['jsonl', 'accepted.json']
  .some((ext) => fs.existsSync(path.join(stateDir(), `${projectId(root)}.${ext}`)));

// ---------- accepted snapshots of the rules ----------
//
// flowrail records what red-lines.json and config.json looked like the last time flowrail itself
// changed them (init, `redlines add`, a dashboard save, an edit the human approved in Claude
// Code, `redlines accept`). Any other change, by any writer (tar -x, git apply, vim, a script),
// is drift: the hook asks on every call until the human reviews it with `flowrail redlines accept`.

/** The files watched for drift, relative to <root>/flowrail/. */
export const WATCHED = ['red-lines.json', 'config.json'];
const MAX_SNAPSHOT = 256 * 1024;
const acceptedPath = (root) => path.join(stateDir(), `${projectId(root)}.accepted.json`);
const pendingPath = (root) => path.join(stateDir(), `${projectId(root)}.pending.json`);
export const watchedPath = (root, name) => path.join(root, 'flowrail', name);

function readBytes(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}
/** sha256 of a file's bytes, 'missing' when there is no file. */
export const contentHash = (buf) => (buf === null || buf === undefined ? 'missing' : sha256(buf));

/** { 'red-lines.json': { sha256, text, at, by }, ... } for this project; {} before first use. */
export function readAccepted(root) {
  try {
    const v = JSON.parse(fs.readFileSync(acceptedPath(root), 'utf8'));
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}

function writeState(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Accept the current content of `names` (default: every watched file). */
export function acceptRules(root, by = 'flowrail', names = WATCHED) {
  const acc = readAccepted(root);
  const at = new Date().toISOString();
  for (const name of names) {
    const buf = readBytes(watchedPath(root, name));
    const hash = contentHash(buf);
    const text = buf && buf.length <= MAX_SNAPSHOT ? buf.toString('utf8') : null;
    acc[name] = { sha256: hash, text, at, by };
    try {
      appendJournal(root, { at, decision: 'accepted', file: `flowrail/${name}`, sha256: hash, by });
    } catch { /* the snapshot is what counts */ }
  }
  writeState(acceptedPath(root), acc);
}

/**
 * The red lines as last accepted, or null when there is no readable copy. While the files drift
 * the hook enforces these too, so emptying red-lines.json never turns a deny into an ask.
 */
export function acceptedLines(root) {
  const text = readAccepted(root)['red-lines.json']?.text;
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Canonical JSON: sorted keys. */
const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v));

/**
 * flowrail itself just wrote `name`: accept the new content, but only when what it replaced was
 * the accepted content (or nothing was accepted yet). `before` is the old text (null: there was
 * no file) or the old value already parsed. A write on top of drift never launders the drift.
 * @returns {boolean} accepted
 */
export function acceptChange(root, name, before, by = 'flowrail') {
  const acc = readAccepted(root)[name];
  if (acc) {
    let same;
    if (before === null || before === undefined) same = acc.sha256 === 'missing';
    else if (typeof before === 'string') same = acc.sha256 === contentHash(Buffer.from(before));
    else {
      try {
        same = acc.text !== null && canon(JSON.parse(acc.text)) === canon(before);
      } catch { same = false; }
    }
    if (!same) return false;
  }
  acceptRules(root, by, [name]);
  return true;
}

/**
 * The config.json keys that matter to safety: `port` (the guard's port red lines) and `actions`
 * and `apps` (commands the dashboard runs). Every other key is layout.
 */
const GUARDED_CONFIG = ['port', 'actions', 'apps'];

/** True when both config texts parse and agree on GUARDED_CONFIG. Unreadable either side: false. */
function sameGuarded(acceptedText, buf) {
  try {
    const obj = (v) => (v && typeof v === 'object' ? v : {});
    const pick = (v) => canon(GUARDED_CONFIG.map((k) => obj(v)[k] ?? null));
    return pick(JSON.parse(acceptedText)) === pick(JSON.parse(buf.toString('utf8')));
  } catch { return false; }
}

/**
 * The watched files that differ from their accepted snapshot, as 'flowrail/<name>'. The first time
 * a project is seen on this machine its files are accepted as they are (a fresh clone is not
 * drift); `firstUse: false` only reads. A config.json change that leaves GUARDED_CONFIG alone is
 * layout, not drift: the snapshot follows it.
 */
export function rulesDrift(root, { firstUse = true } = {}) {
  const acc = readAccepted(root);
  const files = [];
  const fresh = [];
  const layout = [];
  for (const name of WATCHED) {
    const buf = readBytes(watchedPath(root, name));
    if (!acc[name]) fresh.push(name);
    else if (acc[name].sha256 === contentHash(buf)) continue;
    else if (name === 'config.json' && sameGuarded(acc[name].text, buf)) layout.push(name);
    else files.push(`flowrail/${name}`);
  }
  if (layout.length && firstUse) {
    try { acceptRules(root, 'layout-only change', layout); } catch { /* read-only state */ }
  }
  if (fresh.length && firstUse) {
    try { acceptRules(root, 'first use on this machine', fresh); } catch { /* read-only state */ }
  }
  return files;
}

/**
 * The hook asked about an edit of a watched file: remember the content it would produce. If the
 * very next hook call finds exactly that content, the human approved it and it is accepted.
 */
export function setPending(root, name, text) {
  writeState(pendingPath(root), { name, sha256: contentHash(Buffer.from(String(text))) });
}

/**
 * Called once per hook call, before the drift check: a pending edit is settled by the very next
 * call. The file now holds exactly the approved content: accepted. Anything else: dropped.
 */
export function settlePending(root) {
  let p;
  try { p = JSON.parse(fs.readFileSync(pendingPath(root), 'utf8')); } catch { return; }
  try { fs.rmSync(pendingPath(root), { force: true }); } catch { /* next call retries */ }
  if (!p || !WATCHED.includes(p.name)) return;
  if (contentHash(readBytes(watchedPath(root, p.name))) !== p.sha256) return;
  acceptRules(root, 'an edit approved in Claude Code', [p.name]);
}

// ---------- live dashboard ports ----------

/** Ports a running flowrail dashboard listens on (<stateDir>/ports.json, written by it). */
export function livePorts() {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(stateDir(), 'ports.json'), 'utf8'));
    const list = Array.isArray(v) ? v : v && Array.isArray(v.ports) ? v.ports : [];
    return list.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < 65536);
  } catch { return []; }
}

// ---------- comment signatures ----------

/** 32 random bytes, hex, in <stateDir>/key (0600). Created on first use. */
export function machineKey({ create = true } = {}) {
  const file = path.join(stateDir(), 'key');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (e) {
    if (e.code !== 'ENOENT' || !create) return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, key, { mode: 0o600, flag: 'wx' });
  } catch {
    return fs.readFileSync(file, 'utf8').trim();
  }
  return key;
}

const commentPayload = (c) => JSON.stringify([c.path, c.id, c.quote || '', c.body || '',
  c.created || '']);

/** The signature for a comment (hex string). */
export function signComment(c) {
  return crypto.createHmac('sha256', machineKey()).update(commentPayload(c)).digest('hex');
}

/** True when the comment carries a valid signature from this machine's key. Never creates a key. */
export function commentVerified(c) {
  if (!c || typeof c.sig !== 'string' || !/^[0-9a-f]{64}$/.test(c.sig)) return false;
  const key = machineKey({ create: false });
  if (!key) return false;
  const want = crypto.createHmac('sha256', key).update(commentPayload(c)).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(c.sig));
}
