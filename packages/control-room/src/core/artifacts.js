// Artifacts: self-contained HTML reports agents drop into flowrail/artifacts/ for the human.
// Optional sidecar <name>.json: { title, summary, created, tags }.
import fs from 'node:fs';
import path from 'node:path';
import { listFiles, readJson, moveToTrash } from 'flowrail/api';

export const NAME_RE = /^[A-Za-z0-9][\w.-]{0,150}\.html$/;

function titleFromHtml(file) {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    const m = /<title>([^<]{1,200})<\/title>/i.exec(buf.subarray(0, n).toString('utf8'));
    return m ? m[1].trim() : null;
  } catch { return null; }
}

export function list(p) {
  return listFiles(p.artifacts, '.html').filter((n) => NAME_RE.test(n)).map((name) => {
    const file = path.join(p.artifacts, name);
    let side = {};
    try { side = readJson(file.replace(/\.html$/, '.json'), {}) || {}; } catch { side = {}; }
    const st = fs.statSync(file);
    return {
      name,
      title: side.title || titleFromHtml(file) || name.replace(/\.html$/, '').replace(/[-_]+/g, ' '),
      summary: side.summary || '',
      created: side.created || st.mtime.toISOString(),
      tags: Array.isArray(side.tags) ? side.tags : [],
      ...(side.seed === true ? { seed: true } : {}),
      size: st.size,
      href: `/artifacts/${encodeURIComponent(name)}`,
    };
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/** Absolute path of an artifact, or null if the name is not a plain artifact file name. */
export function fileFor(p, name) {
  if (!NAME_RE.test(name)) return null;
  const file = path.join(p.artifacts, name);
  return fs.existsSync(file) ? file : null;
}

export function trash(p, name) {
  const file = fileFor(p, name);
  if (!file) throw Object.assign(new Error(`no artifact ${name}`), { status: 404 });
  moveToTrash(p.root, file);
  const side = file.replace(/\.html$/, '.json');
  if (fs.existsSync(side)) moveToTrash(p.root, side);
  return { name };
}
