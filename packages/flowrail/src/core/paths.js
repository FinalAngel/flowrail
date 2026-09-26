// Workspace discovery and the path security gate.
// Every file the server reads or writes on behalf of the browser goes through safePath().
import fs from 'node:fs';
import path from 'node:path';

/** Walk up from `start` looking for flowrail/config.json. Returns the root or null. */
export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'flowrail', 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Every well-known location inside a workspace. */
export function paths(root) {
  const state = path.join(root, 'flowrail');
  const local = path.join(root, '.flowrail');
  return {
    root,
    state,
    local,
    config: path.join(state, 'config.json'),
    redlines: path.join(state, 'red-lines.json'),
    board: path.join(state, 'board.json'),
    memory: path.join(state, 'memory'),
    memoryIndex: path.join(state, 'memory', 'INDEX.md'),
    workflows: path.join(state, 'workflows'),
    routines: path.join(state, 'routines.json'),
    artifacts: path.join(state, 'artifacts'),
    links: path.join(state, 'links.json'),
    comments: path.join(local, 'comments'),
    runs: path.join(local, 'runs'),
    routinesLog: path.join(local, 'runs', 'routines.log'),
    agents: path.join(local, 'agents'),
    trash: path.join(local, 'trash'),
    redlinesLog: path.join(local, 'redlines.log'),
    activityLog: path.join(local, 'activity.log'),
    checkCache: path.join(local, 'check-results.json'),
    claudeDir: path.join(root, '.claude'),
    settings: path.join(root, '.claude', 'settings.json'),
  };
}

export const SECRET_RE = /(^|\/)(\.env[^/]*|[^/]*\.env|id_[a-z0-9]+|[^/]*\.(pem|key|p12|pfx|jks|keystore)|[^/]*secret[^/]*|[^/]*credential[^/]*|service-account[^/]*\.json|kubeconfig[^/]*|\.npmrc|\.netrc|\.pgpass|\.mcp\.json)$/i;
const BLOCKED_SEGMENT_RE = /(^|\/)(\.git|\.ssh|\.aws|\.gnupg|node_modules|private)(\/|$)|(^|\/)\.flowrail\/trash(\/|$)/;

export const READ_EXT = new Set(['md', 'markdown', 'txt', 'json', 'yml', 'yaml', 'toml', 'csv', 'html', 'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'rb', 'sh', 'css', 'sql']);
export const WRITE_EXT = new Set(['md', 'txt']);

export class PathError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'PathError';
    this.status = status;
  }
}

const extOf = (p) => path.extname(p).slice(1).toLowerCase();

/**
 * Check a browser-supplied relative path. Returns the absolute path or throws PathError.
 * @param {string} root workspace root
 * @param {string} rel  relative path using forward slashes
 * @param {{write?: boolean, mustExist?: boolean}} [opts]
 */
export function safePath(root, rel, opts = {}) {
  if (typeof rel !== 'string' || rel.length === 0) throw new PathError('path is required');
  if (rel.length >= 400) throw new PathError('path is too long');
  if (rel.includes('\0') || rel.includes('\\')) throw new PathError('path contains forbidden characters');
  if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) throw new PathError('path must be relative');
  const norm = path.posix.normalize(rel);
  if (norm.split('/').includes('..') || rel.split('/').includes('..')) throw new PathError('path must not contain ..');
  if (SECRET_RE.test(norm)) throw new PathError('path looks like a secret and is not served', 403);
  if (BLOCKED_SEGMENT_RE.test(norm)) throw new PathError('path is inside a folder flowrail does not serve', 403);
  const ext = extOf(norm);
  const allowed = opts.write ? WRITE_EXT : READ_EXT;
  if (!allowed.has(ext)) throw new PathError(`.${ext || '(none)'} files are not ${opts.write ? 'writable' : 'readable'} here`, 403);

  const rootReal = fs.realpathSync(root);
  const abs = path.join(rootReal, norm);
  // Resolve symlinks on the longest existing prefix and make sure we stay inside the root.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new PathError('path escapes the workspace', 403);
  if (opts.mustExist && !fs.existsSync(abs)) throw new PathError('file not found', 404);
  // A symlink (envlink.md -> .env) is judged by what it points at, not by its own name.
  if (probe === abs) {
    const target = toPosix(path.relative(rootReal, real));
    if (SECRET_RE.test(target)) throw new PathError('path points at a file that looks like a secret and is not served', 403);
    if (BLOCKED_SEGMENT_RE.test(target)) throw new PathError('path points inside a folder flowrail does not serve', 403);
    if (!allowed.has(extOf(target))) throw new PathError(`path points at a .${extOf(target) || '(none)'} file, which is not ${opts.write ? 'writable' : 'readable'} here`, 403);
    // A hard link (ln ../outside.txt notes.md) shares its content with a file that may live
    // anywhere; its name says nothing about what it is, so it is not served.
    const st = fs.statSync(abs);
    if (st.isFile() && st.nlink > 1) throw new PathError('path is a hard link to another file and is not served', 403);
  }
  return abs;
}

/** Same checks as safePath but returns a boolean; used when listing. */
export function isServable(rel) {
  return !SECRET_RE.test(rel) && !BLOCKED_SEGMENT_RE.test(rel) && READ_EXT.has(extOf(rel));
}

export const toPosix = (p) => p.split(path.sep).join('/');
