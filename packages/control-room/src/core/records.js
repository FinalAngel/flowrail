// Records: a folder of Markdown files, one record per file, its frontmatter the fields. Configured in
// flowrail/config.json "records" (file-only): shown as a table and as a board grouped by a status
// field. Reads and writes go through the Docs gate (safePath, docsRoots); a move rewrites one line.
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, nowIso } from 'flowrail/api';
import { parseFrontmatter } from './frontmatter.js';
import { readDoc, writeDoc } from './docs.js';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const FIELD = /^[A-Za-z0-9_-]{1,40}$/;
const TONES = ['accent', 'info', 'warn', 'danger', 'muted'];
const MAX = 2000;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const strs = (v, re = FIELD) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && re.test(x)).slice(0, 20) : []);

/** The valid collections in config.records, plus a sentence per entry that was dropped. */
export function collections(config = {}) {
  const out = [];
  const errors = [];
  for (const [i, c] of (Array.isArray(config.records) ? config.records : []).entries()) {
    const where = `records[${i}]`;
    if (!c || typeof c !== 'object' || !ID.test(c.id || '')) { errors.push(`${where}: id must be lower-case letters, digits and dashes`); continue; }
    const dir = String(c.dir || '').replace(/^\.\/|\/+$/g, '');
    if (!dir || path.isAbsolute(dir) || dir.split('/').includes('..')) { errors.push(`${where} (${c.id}): dir must be a folder inside the repo`); continue; }
    if (out.some((x) => x.id === c.id)) { errors.push(`${where}: id ${c.id} is used twice`); continue; }
    const st = c.status && typeof c.status === 'object' ? c.status : {};
    const field = FIELD.test(st.field || '') ? st.field : 'status';
    const values = strs(st.values, /^[\w .-]{1,40}$/);
    const board = strs(st.board, /^[\w .-]{1,40}$/).filter((v) => values.includes(v));
    const tones = Object.fromEntries(Object.entries(st.tones || {}).filter(([k, v]) => values.includes(k) && TONES.includes(v)));
    out.push({
      id: c.id,
      title: typeof c.title === 'string' && c.title.trim() ? c.title.trim().slice(0, 40) : c.id,
      dir,
      group: typeof c.group === 'string' && c.group.trim() ? c.group.trim().slice(0, 40) : 'Records',
      status: { field, values, board: board.length ? board : values, tones },
      columns: strs(c.columns),
      filters: strs(c.filters),
      due: FIELD.test(c.due || '') ? c.due : null,
      titleField: FIELD.test(c.title_field || c.titleField || '') ? (c.title_field || c.titleField) : null,
    });
  }
  return { list: out, errors };
}

const cache = new Map();

/** Every record in a collection: { path, name, title, status, due, fields, mtime }. Cached 2 s. */
export function list(root, col, now = Date.now()) {
  const key = `${root}\0${col.id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < 2000) return hit.value;
  let names = [];
  try { names = fs.readdirSync(path.join(root, col.dir), { withFileTypes: true }).filter((e) => e.isFile() && /\.md$/i.test(e.name) && !/^(readme|index)\.md$/i.test(e.name)).map((e) => e.name).sort(); } catch { names = []; }
  const records = [];
  for (const name of names.slice(0, MAX)) {
    const rel = `${col.dir}/${name}`;
    let doc;
    try { doc = readDoc(root, rel); } catch { continue; } // secrets, docsRoots, too large: not a record
    const { data, body } = parseFrontmatter(doc.text);
    const h1 = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    const str = (v) => (Array.isArray(v) ? v.join(', ') : v == null ? '' : String(v));
    const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, str(v)]));
    records.push({
      path: rel,
      name: name.replace(/\.md$/i, ''),
      title: (col.titleField && fields[col.titleField]) || fields.title || h1 || name.replace(/\.md$/i, '').replace(/[-_]+/g, ' '),
      status: fields[col.status.field] || '',
      due: col.due && /^\d{4}-\d{2}-\d{2}/.test(fields[col.due] || '') ? fields[col.due].slice(0, 10) : null,
      fields,
      mtime: doc.mtime,
    });
  }
  const value = { records, truncated: names.length > MAX };
  cache.set(key, { at: now, value });
  return value;
}

/**
 * Set a record's status: only the status line of its frontmatter changes, the rest of the file stays
 * byte for byte. Refused when the file changed since the page read it (mtime), when the value is not
 * one of the collection's, or when the path is not a record of this collection.
 */
export function move(p, col, rel, status, mtime) {
  if (typeof rel !== 'string' || !rel.startsWith(col.dir + '/') || rel.slice(col.dir.length + 1).includes('/') || !/\.md$/i.test(rel)) throw bad('path must be a record in this collection');
  if (!col.status.values.includes(status)) throw bad(`status must be one of ${col.status.values.join(', ')}`);
  const doc = readDoc(p.root, rel);
  if (mtime !== undefined && mtime !== null && Math.abs(doc.mtime - Number(mtime)) > 1) throw Object.assign(bad('changed on disk since the page loaded it; reload', 409), { mtime: doc.mtime });
  const m = /^(﻿?---\r?\n)([\s\S]*?)(\r?\n---\r?\n?)/.exec(doc.text);
  if (!m) throw bad('this file has no frontmatter to hold a status', 422);
  const nl = m[2].includes('\r\n') ? '\r\n' : '\n';
  const lineRe = new RegExp(`^${col.status.field}:[^\\r\\n]*$`, 'm');
  const value = /[:#"'\[\]{}]|^\s|\s$/.test(status) ? JSON.stringify(status) : status;
  const block = lineRe.test(m[2]) ? m[2].replace(lineRe, `${col.status.field}: ${value}`) : `${m[2]}${nl}${col.status.field}: ${value}`;
  const from = parseFrontmatter(doc.text).data[col.status.field] || '';
  const text = m[1] + block + m[3] + doc.text.slice(m[0].length);
  const r = writeDoc(p.root, rel, text, doc.mtime);
  cache.delete(`${p.root}\0${col.id}`);
  try { appendLine(p.activityLog, { at: nowIso(), kind: 'record', collection: col.id, path: rel, from: String(from), to: status, by: 'human' }); } catch { /* best effort */ }
  return { path: rel, status, mtime: r.mtime };
}
