// Library: every Markdown document with its area, last change and staleness. Context: the
// reference library. Links: the bookmarks page. All read-only.
//
// Areas are the generic form of "one router per department": config `areas`
// [{ name, router }] or, without it, a CLAUDE.md table whose rows link a Markdown router
// (`| Sales | [SALES.md](SALES.md) | ... |`). A document belongs to the area whose router names
// it, or else names a folder above it (the longest folder wins).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { safePath } from 'flowrail/api';
import { listDocs } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';

const DAY = 86400000;
const HEAD = 4096;

function head(abs, n = HEAD) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(n);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, n, 0));
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Frontmatter title, else the first "# " heading, else the file name. */
export function titleOf(text, rel) {
  const { data, body } = parseFrontmatter(text);
  if (typeof data.title === 'string' && data.title.trim()) return data.title.trim();
  const h1 = /^#\s+(.+?)\s*#*\s*$/m.exec(body);
  return h1 ? h1[1] : path.posix.basename(rel).replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
}

// ---------- areas ----------

/** Rows of a CLAUDE.md table that link a Markdown router: [{ name, router }]. */
export function areasFromTable(text) {
  const out = [];
  for (const m of String(text).matchAll(/^\|\s*([^|\n]*?[A-Za-z][^|\n]*?)\s*\|\s*\[[^\]\n]*\]\(([^)\s#]+\.md)\)/gm)) {
    if (!/^[-: ]+$/.test(m[1])) out.push({ name: m[1].replace(/\*\*/g, ''), router: m[2].replace(/^\.\//, '') });
  }
  return out;
}

/** Repo-relative paths a router names: link targets, `code` spans and bare a/b paths. */
export function mentions(text, routerRel) {
  const dir = path.posix.dirname(routerRel);
  const found = new Set();
  const add = (raw) => {
    const r = String(raw).trim().replace(/^<|>$/g, '').replace(/[#?].*$/, '').replace(/[.,;:)]+$/, '');
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
  const list = Array.isArray(config.areas) && config.areas.length
    ? config.areas.filter((a) => a && typeof a.name === 'string' && typeof a.router === 'string')
    : areasFromTable(head(path.join(root, 'CLAUDE.md'), 256 * 1024));
  return list.flatMap(({ name, router }) => {
    let abs;
    try { abs = safePath(root, router, { mustExist: true }); } catch { return []; }
    const named = mentions(head(abs, 256 * 1024), router);
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

// ---------- staleness ----------

/** fresh / aging / stale from days since the last change and [agingAfter, staleAfter]. */
export function staleness(days, [aging, stale] = [30, 90]) {
  if (days === null || days === undefined) return 'unknown';
  return days >= stale ? 'stale' : days >= aging ? 'aging' : 'fresh';
}

const gitCache = new Map();
/** Last commit time per path from one `git log`, 'dirty' for changed or untracked files; null outside git. Cached 5 s. */
export function gitDates(root, now = Date.now()) {
  const hit = gitCache.get(root);
  if (hit && now - hit.at < 5000) return hit.dates;
  let dates = null;
  try {
    const out = execFileSync('git', ['-C', root, 'log', '--relative', '--format=%x00%ct', '--name-only', '--no-renames', '--', '*.md', '*.markdown'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    dates = new Map();
    for (const chunk of out.split('\0').slice(1)) {
      const [ts, ...files] = chunk.split('\n');
      const t = Number(ts) * 1000;
      for (const f of files) if (f && !dates.has(f)) dates.set(f, t);
    }
    // Files changed since their last commit take their mtime (a fresh clone's mtimes say nothing).
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain', '-z', '--untracked-files=all', '--', '.'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const prefix = execFileSync('git', ['-C', root, 'rev-parse', '--show-prefix'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    for (const entry of status.split('\0')) {
      const f = entry.slice(3);
      if (entry.length > 3 && f.startsWith(prefix)) dates.set(f.slice(prefix.length), 'dirty');
    }
  } catch { /* not a git repo, or no git */ }
  gitCache.set(root, { at: now, dates });
  return dates;
}

export function library(root, config = {}, now = Date.now()) {
  const thresholds = Array.isArray(config.staleDays) && config.staleDays.length === 2 ? config.staleDays.map(Number) : [30, 90];
  const list = areas(root, config);
  const dates = gitDates(root, now);
  const docs = listDocs(root).filter((rel) => /\.(md|markdown)$/i.test(rel)).map((rel) => {
    const abs = path.join(root, rel);
    let changed = dates?.get(rel) ?? null;
    const uncommitted = dates !== null && (changed === 'dirty' || changed === null);
    if (changed === 'dirty' || changed === null) {
      try { changed = fs.statSync(abs).mtimeMs; } catch { changed = null; }
    }
    const days = changed === null ? null : Math.max(0, Math.floor((now - changed) / DAY));
    return { path: rel, title: titleOf(head(abs), rel), area: areaOf(rel, list), changed: changed && new Date(changed).toISOString(), days, state: staleness(days, thresholds), ...(uncommitted ? { uncommitted: true } : {}) };
  });
  const counts = { fresh: 0, aging: 0, stale: 0, unknown: 0 };
  for (const d of docs) counts[d.state]++;
  return {
    docs,
    counts,
    thresholds,
    source: dates ? 'git' : 'mtime',
    areas: list.map((a) => ({ name: a.name, router: a.router, docs: docs.filter((d) => d.area === a.name).length })),
  };
}

// ---------- context ----------

/** One entry per folder of contextDir holding an index.md: its frontmatter and sibling docs. */
export function context(root, config = {}) {
  const rel = typeof config.contextDir === 'string' && config.contextDir.trim() ? config.contextDir.replace(/\/+$/, '') : 'flowrail/context';
  let dir;
  // safePath judges files; a probe name inside the folder checks the folder the same way.
  try { dir = path.dirname(safePath(root, `${rel}/index.md`)); } catch { return { dir: rel, entries: [], error: 'contextDir is outside the repo or not served' }; }
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch { /* none yet */ }
  const entries = names.sort().flatMap((slug) => {
    const base = `${rel}/${slug}`;
    let index;
    try { index = safePath(root, `${base}/index.md`, { mustExist: true }); } catch { return []; }
    const text = head(index, 64 * 1024);
    const { data } = parseFrontmatter(text);
    const str = (v) => (typeof v === 'string' ? v : '');
    const docs = fs.readdirSync(path.dirname(index)).filter((f) => /\.md$/i.test(f) && f !== 'index.md').sort().map((f) => `${base}/${f}`)
      .filter((r) => { try { safePath(root, r, { mustExist: true }); return true; } catch { return false; } });
    let changed = null;
    try { changed = new Date(fs.statSync(index).mtimeMs).toISOString(); } catch { /* gone */ }
    const title = titleOf(text, `${base}/index.md`);
    return [{ slug, title: title === 'index' ? slug : title, source: str(data.source), summary: str(data.summary), path: `${base}/index.md`, docs, changed }];
  });
  return { dir: rel, entries };
}

// ---------- links ----------

const ICON_NAME = /^[a-z][a-zA-Z0-9]{0,30}$/;

/**
 * flowrail/links.json as [{ category, items: [{ title, url, description?, icon?, href, external }] }].
 * Categories may call their list `items` or `links`. http(s) URLs open outside; a relative path
 * opens in Docs; anything else (javascript:, data:, file:) is dropped.
 */
export function normalizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  return raw.filter((c) => c && typeof c === 'object').map((c) => ({
    category: str(c.category, 80) || 'Links',
    items: (Array.isArray(c.items) ? c.items : Array.isArray(c.links) ? c.links : []).flatMap((l) => {
      const url = str(l?.url, 2000);
      const title = str(l?.title, 120);
      if (!url || !title) return [];
      let href;
      let external = false;
      if (/^https?:\/\//i.test(url)) {
        try { href = new URL(url).href; external = true; } catch { return []; }
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && !url.startsWith('//') && !url.includes('..')) {
        href = '#/docs?path=' + encodeURIComponent(url.replace(/^\.?\//, ''));
      } else return [];
      const icon = str(l.icon, 31);
      return [{ title, url, href, external, description: str(l.description, 240), ...(ICON_NAME.test(icon) ? { icon } : {}) }];
    }),
  })).filter((c) => c.items.length);
}

export const links = (p, readJson) => normalizeLinks(readJson(p.links, []));
