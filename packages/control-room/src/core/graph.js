// Knowledge graph: folders, Markdown docs, memories, skills, agents, workflows, routines, red lines
// and artifacts, joined by folder containment, Markdown links and [[wikilinks]]. Every node also
// carries the ring the Rings view draws it on and, for files, the area it belongs to.
import fs from 'node:fs';
import path from 'node:path';
import { areas as libraryAreas, areaOf as libraryAreaOf } from './library.js';
import { listDocs } from './docs.js';
import { readText } from 'flowrail/api';
import { memoryFor } from './memory.js';
import { load as loadRoutines } from './routines.js';
import { workflowsDir } from './workflows.js';
import { loadLines } from 'flowrail/api';
import { loadConfig } from 'flowrail/api';
import { list as listArtifacts } from './artifacts.js';

const MAX_NODES = 1500;
const MAX_AREAS = 12;

/** Which ring of the Rings view a kind sits on. */
export const RING = { hub: 'hub', skill: 'skill', agent: 'skill', doc: 'band', folder: 'band', memory: 'band', workflow: 'band', routine: 'routine', redline: 'routine', artifact: 'artifact' };

/**
 * The areas of the repo, as the Library defines them (src/core/library.js): config `areas`, else a
 * CLAUDE.md router table; a file belongs to the area whose router names it or a folder above it.
 * @returns {{areas: {name:string, router:string}[], areaOf: (rel:string) => number|null}}
 */
export function areasOf(p, config = loadConfig(p)) {
  const list = libraryAreas(p.root, config).slice(0, MAX_AREAS);
  const index = new Map(list.map((a, i) => [a.name, i]));
  return {
    areas: list.map(({ name, router }) => ({ name: name.slice(0, 40), router })),
    areaOf: (rel) => { const name = libraryAreaOf(rel, list); return name === null ? null : index.get(name); },
  };
}

function kindFor(rel, wf = 'flowrail/workflows') {
  if (/^flowrail\/memory\/(?!INDEX\.md$)[^/]+\.md$/.test(rel)) return 'memory';
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return 'skill';
  if (/^\.claude\/agents\/[^/]+\.md$/.test(rel)) return 'agent';
  if (/^\.claude\/commands\/[^/]+\.md$/.test(rel)) return 'command';
  if (path.posix.dirname(rel) === wf && rel.endsWith('.md')) return 'workflow';
  return 'doc';
}

export function build(p) {
  const nodes = new Map();
  const links = [];
  const add = (n) => { if (!nodes.has(n.id) && nodes.size < MAX_NODES) nodes.set(n.id, { size: 1, ...n }); return nodes.has(n.id); };
  const link = (source, target, kind) => { if (source !== target) links.push({ source, target, kind }); };
  const config = loadConfig(p);
  const { areas, areaOf } = areasOf(p, config);
  const wfDir = path.relative(p.root, workflowsDir(p)).split(path.sep).join('/');
  add({ id: 'hub', kind: 'hub', label: config.name || path.basename(p.root), ...(fs.existsSync(path.join(p.root, 'CLAUDE.md')) ? { path: 'CLAUDE.md' } : {}) });

  const memByName = new Map(memoryFor(p).list().map((m) => [m.name, m]));
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

  // Routines, red lines and artifacts first, then skills and agents, then documents: when the cap
  // is reached it drops documents, never the few things on the outer rings.
  const artDir = path.relative(p.root, p.artifacts).split(path.sep).join('/');
  for (const r of loadRoutines(p)) if (add({ id: `routine:${r.id}`, kind: 'routine', label: r.title || r.id, path: 'flowrail/routines.json' })) link('hub', `routine:${r.id}`, 'module');
  for (const l of loadLines(p)) if (add({ id: `redline:${l.id}`, kind: 'redline', label: l.title || l.id, path: 'flowrail/red-lines.json' })) link('hub', `redline:${l.id}`, 'module');
  for (const a of listArtifacts(p)) add({ id: `artifact:${a.name}`, kind: 'artifact', label: a.title, path: `${artDir}/${a.name}`, href: a.href });
  const rank = (rel) => (kindFor(rel, wfDir) === 'doc' ? 1 : 0);
  files.sort((a, b) => rank(a) - rank(b));

  for (const rel of files) {
    const kind = kindFor(rel, wfDir);
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
