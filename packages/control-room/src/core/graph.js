// Knowledge graph: folders, Markdown docs, memories, skills, agents, workflows, routines, red lines
// and artifacts, joined by folder containment, Markdown links and [[wikilinks]]. Every node also
// carries the ring the Rings view draws it on and, for files, the area it belongs to.
import fs from 'node:fs';
import path from 'node:path';
import { listDocs } from './docs.js';
import { readText } from 'flowrail/api';
import { list as listMemory } from './memory.js';
import { load as loadRoutines } from './routines.js';
import { loadLines } from 'flowrail/api';
import { loadConfig } from 'flowrail/api';
import { list as listArtifacts } from './artifacts.js';

const MAX_NODES = 1500;
const MAX_AREAS = 12;

/** Which ring of the Rings view a kind sits on. */
export const RING = { hub: 'hub', skill: 'skill', agent: 'skill', doc: 'band', folder: 'band', memory: 'band', workflow: 'band', routine: 'routine', redline: 'routine', artifact: 'artifact' };

/**
 * The areas of the repo: config `areas: [{ name, router }]`, else the rows of a CLAUDE.md table that
 * link a router (`| Sales | [SALES.md](SALES.md) | ... |`). A file belongs to the area whose router
 * names it (a Markdown link, or a path in backticks), or names a folder above it; the most specific
 * wins, and a router belongs to its own area.
 * @returns {{areas: {name:string, router:string}[], areaOf: (rel:string) => number|null}}
 */
export function areasOf(p, config = loadConfig(p)) {
  let defs = Array.isArray(config.areas) ? config.areas.filter((a) => a && typeof a.name === 'string' && typeof a.router === 'string') : [];
  if (!defs.length) {
    const cm = readText(path.join(p.root, 'CLAUDE.md'));
    for (const m of cm.matchAll(/^\|\s*([^|\n]*?[^|\s][^|\n]*?)\s*\|\s*\[[^\]]*\]\(([^)\s]+\.md)\)/gm)) defs.push({ name: m[1], router: m[2] });
  }
  const seen = new Set();
  const areas = [];
  for (const d of defs) {
    const router = path.posix.normalize(d.router.replace(/^\.\//, ''));
    if (router.startsWith('..') || path.posix.isAbsolute(router) || seen.has(router) || areas.length >= MAX_AREAS) continue;
    seen.add(router);
    areas.push({ name: d.name.slice(0, 40), router });
  }
  const files = new Map();
  const dirs = [];
  areas.forEach((a, i) => {
    files.set(a.router, i);
    const text = readText(path.join(p.root, a.router)).slice(0, 256 * 1024);
    const base = path.posix.dirname(a.router);
    const mention = (rel, isDir) => {
      rel = path.posix.normalize(rel).replace(/\/$/, '');
      if (!rel || rel === '.' || rel.startsWith('..')) return;
      let dir = isDir;
      if (!dir) { try { dir = fs.statSync(path.join(p.root, rel)).isDirectory(); } catch { dir = false; } }
      if (dir) dirs.push([rel + '/', i]);
      else if (!files.has(rel)) files.set(rel, i);
    };
    for (const m of text.matchAll(/\]\(([^)\s#?]+)/g)) {
      if (/^[a-z]+:/i.test(m[1]) || m[1].startsWith('/')) continue;
      try { mention(path.posix.join(base, decodeURIComponent(m[1])), m[1].endsWith('/')); } catch { /* bad escape */ }
    }
    for (const m of text.matchAll(/`([\w.@-]+(?:\/[\w.@-]*)+)`/g)) mention(m[1], m[1].endsWith('/'));
  });
  dirs.sort((a, b) => b[0].length - a[0].length);
  const areaOf = (rel) => {
    if (files.has(rel)) return files.get(rel);
    const hit = dirs.find(([d]) => rel.startsWith(d));
    return hit ? hit[1] : null;
  };
  return { areas, areaOf };
}

function kindFor(rel) {
  if (/^flowrail\/memory\/(?!INDEX\.md$)[^/]+\.md$/.test(rel)) return 'memory';
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return 'skill';
  if (/^\.claude\/agents\/[^/]+\.md$/.test(rel)) return 'agent';
  if (/^\.claude\/commands\/[^/]+\.md$/.test(rel)) return 'command';
  if (/^flowrail\/workflows\/[^/]+\.md$/.test(rel)) return 'workflow';
  return 'doc';
}

export function build(p) {
  const nodes = new Map();
  const links = [];
  const add = (n) => { if (!nodes.has(n.id) && nodes.size < MAX_NODES) nodes.set(n.id, { size: 1, ...n }); return nodes.has(n.id); };
  const link = (source, target, kind) => { if (source !== target) links.push({ source, target, kind }); };
  const config = loadConfig(p);
  const { areas, areaOf } = areasOf(p, config);
  add({ id: 'hub', kind: 'hub', label: config.name || path.basename(p.root), ...(fs.existsSync(path.join(p.root, 'CLAUDE.md')) ? { path: 'CLAUDE.md' } : {}) });

  const memByName = new Map(listMemory(p).map((m) => [m.name, m]));
  const files = listDocs(p.root, 3000).filter((f) => /\.(md|markdown)$/i.test(f));
  const idFor = new Map();
  const byBase = new Map();

  const folderId = (dir) => (dir ? `folder:${dir}` : 'hub');
  const ensureFolder = (dir) => {
    if (!dir) return 'hub';
    const id = folderId(dir);
    if (!nodes.has(id)) {
      const parent = ensureFolder(path.posix.dirname(dir) === '.' ? '' : path.posix.dirname(dir));
      if (add({ id, kind: 'folder', label: path.posix.basename(dir), path: dir })) link(parent, id, 'contains');
    }
    return id;
  };

  for (const rel of files) {
    const kind = kindFor(rel);
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    let id;
    let label = path.posix.basename(rel);
    if (kind === 'memory') {
      const name = path.posix.basename(rel, '.md');
      id = `memory:${name}`;
      label = memByName.get(name)?.description?.slice(0, 60) || name;
    } else if (kind === 'skill') {
      id = `skill:${path.posix.basename(dir)}`;
      label = path.posix.basename(dir);
    } else if (kind === 'agent') {
      id = `agent:${path.posix.basename(rel, '.md')}`;
      label = path.posix.basename(rel, '.md');
    } else if (kind === 'command') {
      id = `command:${path.posix.basename(rel, '.md')}`;
      label = '/' + path.posix.basename(rel, '.md');
    } else if (kind === 'workflow') {
      id = `workflow:${path.posix.basename(rel, '.md')}`;
      label = path.posix.basename(rel, '.md');
    } else {
      id = `doc:${rel}`;
    }
    const parent = kind === 'skill' ? ensureFolder(path.posix.dirname(dir)) : ensureFolder(dir);
    const area = areaOf(rel);
    // Commands are drawn as skills: both are things you invoke by name.
    if (!add({ id, kind: kind === 'command' ? 'skill' : kind, label, path: rel, ...(area !== null ? { area } : {}) })) continue;
    link(parent, id, 'contains');
    idFor.set(rel, id);
    byBase.set(path.posix.basename(rel, path.posix.extname(rel)).toLowerCase(), id);
  }

  for (const r of loadRoutines(p)) if (add({ id: `routine:${r.id}`, kind: 'routine', label: r.title || r.id, path: 'flowrail/routines.json' })) link('hub', `routine:${r.id}`, 'module');
  for (const l of loadLines(p)) if (add({ id: `redline:${l.id}`, kind: 'redline', label: l.title || l.id, path: 'flowrail/red-lines.json' })) link('hub', `redline:${l.id}`, 'module');
  for (const a of listArtifacts(p)) add({ id: `artifact:${a.name}`, kind: 'artifact', label: a.title, path: `flowrail/artifacts/${a.name}`, href: a.href });
  for (const n of nodes.values()) {
    n.ring = RING[n.kind] || 'band';
    if (n.kind === 'folder' && areaOf(n.path + '/') !== null) n.area = areaOf(n.path + '/');
  }

  // Markdown links and wikilinks.
  for (const rel of files) {
    const from = idFor.get(rel);
    if (!from) continue;
    const text = readText(path.join(p.root, rel));
    if (text.length > 512 * 1024) continue;
    for (const m of text.matchAll(/\]\(([^)\s#?]+)(?:[#?][^)]*)?\)/g)) {
      const target = m[1];
      if (/^[a-z]+:/i.test(target) || target.startsWith('/')) continue;
      let resolved;
      try { resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), decodeURIComponent(target))); } catch { continue; }
      const to = idFor.get(resolved) || (nodes.has(folderId(resolved.replace(/\/$/, ''))) ? folderId(resolved.replace(/\/$/, '')) : null);
      if (to) link(from, to, 'link');
    }
    for (const m of text.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)) {
      const key = m[1].trim();
      const to = memByName.has(key) && nodes.has(`memory:${key}`) ? `memory:${key}` : byBase.get(key.toLowerCase().replace(/\.md$/, ''));
      if (to) link(from, to, 'wikilink');
    }
  }

  const unique = new Map();
  for (const l of links) if (nodes.has(l.source) && nodes.has(l.target)) unique.set(`${l.source}>${l.target}>${l.kind}`, l);
  const finalLinks = [...unique.values()];
  for (const l of finalLinks) { nodes.get(l.source).size++; nodes.get(l.target).size++; }
  return { nodes: [...nodes.values()], links: finalLinks, areas, truncated: nodes.size >= MAX_NODES };
}
