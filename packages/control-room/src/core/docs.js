// Documents: the file tree, reading and writing through the path gate.
import fs from 'node:fs';
import path from 'node:path';
import { safePath, PathError } from 'flowrail/api';
import { isServable } from 'flowrail/api';
import { walkFiles } from 'flowrail/api';
import { writeText, moveToTrash } from 'flowrail/api';

const TREE_SKIP = new Set(['.git', 'node_modules', '.flowrail', '.next', 'dist', 'build', 'coverage', '.venv', 'venv', '__pycache__', 'target', 'vendor', '.idea', '.vscode', '.cache', '.turbo']);
const MAX_READ = 2 * 1024 * 1024;

// The vendored guard under .claude/flowrail/ is flowrail's own code, not the project's docs; a direct link still opens it.
const GUARD_INTERNALS = /^\.claude\/flowrail\//;

// config "docsRoots": the folders and files a workspace shows (["docs", "README.md"]); unset shows all.
const ROOTS = new Map();
export function setRoots(root, roots) {
  const list = Array.isArray(roots) ? roots.filter((r) => typeof r === 'string' && r && !r.includes('..')).map((r) => r.replace(/^\.\/|\/+$/g, '')) : null;
  if (list && list.length) ROOTS.set(root, list); else ROOTS.delete(root);
}
const inRoots = (root, rel) => { const list = ROOTS.get(root); return !list || list.some((r) => rel === r || rel.startsWith(r + '/')); };
function gate(root, rel, opts) {
  const abs = safePath(root, rel, opts);
  if (!inRoots(root, path.posix.normalize(rel))) throw new PathError('this file is outside the folders this workspace shows (docsRoots)', 403);
  return abs;
}

/** Flat list of servable files (posix relative paths). */
export function listDocs(root, limit = 5000) {
  return walkFiles(root, { limit: limit * 4, skipDirs: TREE_SKIP })
    .filter((rel) => isServable(rel) && inRoots(root, rel) && !/(^|\/)\.(?!claude\/|github\/)[^/]*\//.test(rel) && !GUARD_INTERNALS.test(rel))
    .slice(0, limit);
}

export function tree(root) {
  const top = { name: '', path: '', type: 'dir', children: [] };
  for (const rel of listDocs(root)) {
    const parts = rel.split('/');
    let node = top;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      let child = node.children.find((c) => c.name === part && c.type === (isFile ? 'file' : 'dir'));
      if (!child) {
        child = isFile ? { name: part, path: rel, type: 'file', kind: kindOf(rel) } : { name: part, path: parts.slice(0, i + 1).join('/'), type: 'dir', children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sort = (n) => {
    if (!n.children) return;
    n.children.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    n.children.forEach(sort);
  };
  sort(top);
  return top.children;
}

export function kindOf(rel) {
  const ext = path.extname(rel).slice(1).toLowerCase();
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (ext === 'txt') return 'text';
  if (ext === 'json' || ext === 'html' || ext === 'csv') return ext;
  if (['yml', 'yaml', 'toml'].includes(ext)) return 'config';
  return 'code';
}

export function readDoc(root, rel) {
  const abs = gate(root, rel, { mustExist: true });
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new PathError('not a file', 400);
  if (st.size > MAX_READ) throw new PathError('file is larger than 2 MB', 413);
  return { path: rel, text: fs.readFileSync(abs, 'utf8'), mtime: st.mtimeMs, kind: kindOf(rel), size: st.size, writable: /\.(md|txt)$/i.test(rel) };
}

export function writeDoc(root, rel, text, mtime) {
  const abs = gate(root, rel, { write: true, mustExist: true });
  if (typeof text !== 'string') throw new PathError('text must be a string');
  if (Buffer.byteLength(text) > MAX_READ) throw new PathError('file would be larger than 2 MB', 413);
  const st = fs.statSync(abs);
  if (mtime !== undefined && mtime !== null && Math.abs(st.mtimeMs - Number(mtime)) > 1) {
    throw Object.assign(new PathError('changed on disk since you opened it; reload to see the new version', 409), { mtime: st.mtimeMs });
  }
  writeText(abs, text);
  return { path: rel, mtime: fs.statSync(abs).mtimeMs };
}

export function createDoc(root, rel, text) {
  const abs = gate(root, rel, { write: true });
  if (fs.existsSync(abs)) throw new PathError('a file with that name already exists', 409);
  const title = path.basename(rel).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
  writeText(abs, typeof text === 'string' ? text : rel.endsWith('.md') ? `# ${title[0]?.toUpperCase() ?? ''}${title.slice(1)}\n` : '');
  return { path: rel, mtime: fs.statSync(abs).mtimeMs };
}

export function trashDoc(root, rel) {
  const abs = gate(root, rel, { mustExist: true });
  return { path: rel, trashedTo: path.relative(root, moveToTrash(root, abs)) };
}

/** Markdown headings of a file: [{level, text, line}] */
export function headings(text) {
  const out = [];
  let inCode = false;
  String(text).split('\n').forEach((line, i) => {
    if (line.startsWith('```')) inCode = !inCode;
    const m = !inCode && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2], line: i + 1 });
  });
  return out;
}
