// Small shared helpers: JSON files, dates, ids, trash. No dependencies.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    if (fallback !== undefined && err instanceof SyntaxError) {
      const e = new Error(`${file} is not valid JSON: ${err.message}`);
      e.code = 'EBADJSON';
      throw e;
    }
    throw err;
  }
}

/** Write JSON atomically (temp file + rename) so a crash never leaves half a file. */
export function writeJson(file, data) {
  writeText(file, JSON.stringify(data, null, 2) + '\n');
}

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n');
}

export function readJsonl(file) {
  const out = [];
  for (const line of readText(file).split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  return out;
}

export const pad = (n) => String(n).padStart(2, '0');

/** Local calendar date as YYYY-MM-DD. */
export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Parse YYYY-MM-DD as a local midnight Date. */
export function parseDate(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Monday of the week containing `d`, as YYYY-MM-DD. */
export function mondayOf(d = new Date()) {
  const day = (d.getDay() + 6) % 7;
  return localDate(addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -day));
}

export const nowIso = () => new Date().toISOString();

export const randomId = (bytes = 3) => crypto.randomBytes(bytes).toString('hex');

export function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function slugify(s, max = 48) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'item';
}

/** Move a file or folder into .flowrail/trash/ with a timestamp prefix. Never deletes. */
export function moveToTrash(root, abs) {
  const trash = path.join(root, '.flowrail', 'trash');
  fs.mkdirSync(trash, { recursive: true });
  const rel = path.relative(root, abs).split(path.sep).join('__');
  const dest = path.join(trash, `${stamp()}-${randomId(2)}-${rel}`);
  fs.renameSync(abs, dest);
  return dest;
}

export function trashJson(root, label, data) {
  const dest = path.join(root, '.flowrail', 'trash', `${stamp()}-${randomId(2)}-${label}.json`);
  writeJson(dest, data);
  return dest;
}

export function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

export function listFiles(dir, ext) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && (!ext || e.name.endsWith(ext)))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function daysAgo(iso, now = Date.now()) {
  return (now - new Date(iso).getTime()) / 86400000;
}
