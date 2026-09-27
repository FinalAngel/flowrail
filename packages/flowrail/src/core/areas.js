// Areas: the generic form of "one router per department". Config `areas` [{ name, router }], or
// without it a CLAUDE.md table whose rows link a Markdown router (`| Sales | [SALES.md](SALES.md) |`).
// A document belongs to the area whose router names it, or else names a folder above it (the
// longest folder wins). The room's Library and map, and `flowrail check`, share this one reading.
import fs from 'node:fs';
import path from 'node:path';
import { safePath } from './paths.js';

const CAP = 256 * 1024;

export function head(abs, n = CAP) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(n);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, n, 0));
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Rows of a CLAUDE.md table that link a Markdown router: [{ name, router }]. */
export function areasFromTable(text) {
  const out = [];
  for (const m of String(text).matchAll(/^\|\s*([^|\n]*?[A-Za-z][^|\n]*?)\s*\|\s*\[[^\]\n]*\]\(([^)\s#]+\.md)\)/gm)) {
    if (!/^[-: ]+$/.test(m[1])) out.push({ name: m[1].replace(/\*\*/g, ''), router: m[2].replace(/^\.\//, '') });
  }
  return out;
}

/** The areas as written: config `areas`, else the CLAUDE.md table. [{ name, router }] */
export function areaList(root, config = {}) {
  return Array.isArray(config.areas) && config.areas.length
    ? config.areas.filter((a) => a && typeof a.name === 'string' && typeof a.router === 'string')
    : areasFromTable(head(path.join(root, 'CLAUDE.md')));
}

const clean = (raw) => String(raw).trim().replace(/^<|>$/g, '').replace(/[#?].*$/, '').replace(/[.,;:)]+$/, '');

/** Repo-relative paths a router names: link targets, `code` spans and bare a/b paths. */
export function mentions(text, routerRel) {
  const dir = path.posix.dirname(routerRel);
  const found = new Set();
  const add = (raw) => {
    const r = clean(raw);
    if (!r || /^[a-z]+:/i.test(r) || r.includes('*') || r.startsWith('/')) return;
    for (const base of [dir, '.']) {
      const p = path.posix.normalize(path.posix.join(base, r));
      if (!p.startsWith('..')) found.add(p.replace(/\/$/, '') + (r.endsWith('/') ? '/' : ''));
    }
  };
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1]);
  for (const m of text.matchAll(/`([^`\s]+)`/g)) add(m[1]);
  for (const m of text.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w.-]*)(?=[\s.,;:)]|$)/gm)) add(m[1]);
  return found;
}

/** The workspace's areas with what each router names: [{ name, router, files:Set, dirs:string[] }]. */
export function areas(root, config = {}) {
  return areaList(root, config).flatMap(({ name, router }) => {
    let abs;
    try { abs = safePath(root, router, { mustExist: true }); } catch { return []; }
    const named = mentions(head(abs), router);
    const files = new Set([router]);
    const dirs = [];
    for (const n of named) {
      let isDir = n.endsWith('/');
      if (!isDir) { try { isDir = fs.statSync(path.join(root, n)).isDirectory(); } catch { /* not there */ } }
      if (isDir) dirs.push(n.replace(/\/$/, '') + '/');
      else files.add(n);
    }
    return [{ name, router, files, dirs }];
  });
}

/** The area a document belongs to, or null. An exact mention wins, then the longest folder. */
export function areaOf(rel, list) {
  const exact = list.find((a) => a.files.has(rel));
  if (exact) return exact.name;
  let best = null;
  let len = 0;
  for (const a of list) for (const d of a.dirs) if (rel.startsWith(d) && d.length > len) { best = a.name; len = d.length; }
  return best;
}
