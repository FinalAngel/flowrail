// Knowledge graph: folders, Markdown docs, memories, skills, agents, workflows, routines and red lines,
// joined by folder containment, Markdown links and [[wikilinks]].
import path from 'node:path';
import { listDocs } from './docs.js';
import { readText } from 'flowrail/api';
import { list as listMemory } from './memory.js';
import { load as loadRoutines } from './routines.js';
import { loadLines } from 'flowrail/api';
import { loadConfig } from 'flowrail/api';

const MAX_NODES = 1500;

function kindFor(rel) {
  if (/^flowrail\/memory\/(?!INDEX\.md$)[^/]+\.md$/.test(rel)) return 'memory';
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(rel)) return 'skill';
  if (/^\.claude\/agents\/[^/]+\.md$/.test(rel)) return 'agent';
  if (/^flowrail\/workflows\/[^/]+\.md$/.test(rel)) return 'workflow';
  return 'doc';
}

export function build(p) {
  const nodes = new Map();
  const links = [];
  const add = (n) => { if (!nodes.has(n.id) && nodes.size < MAX_NODES) nodes.set(n.id, { size: 1, ...n }); return nodes.has(n.id); };
  const link = (source, target, kind) => { if (source !== target) links.push({ source, target, kind }); };
  const config = loadConfig(p);
  add({ id: 'hub', kind: 'hub', label: config.name || path.basename(p.root) });

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
    } else if (kind === 'workflow') {
      id = `workflow:${path.posix.basename(rel, '.md')}`;
      label = path.posix.basename(rel, '.md');
    } else {
      id = `doc:${rel}`;
    }
    const parent = kind === 'skill' ? ensureFolder(path.posix.dirname(dir)) : ensureFolder(dir);
    if (!add({ id, kind, label, path: rel })) continue;
    link(parent, id, 'contains');
    idFor.set(rel, id);
    byBase.set(path.posix.basename(rel, path.posix.extname(rel)).toLowerCase(), id);
  }

  for (const r of loadRoutines(p)) if (add({ id: `routine:${r.id}`, kind: 'routine', label: r.title || r.id, path: 'flowrail/routines.json' })) link('hub', `routine:${r.id}`, 'module');
  for (const l of loadLines(p)) if (add({ id: `redline:${l.id}`, kind: 'redline', label: l.title || l.id, path: 'flowrail/red-lines.json' })) link('hub', `redline:${l.id}`, 'module');

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
  return { nodes: [...nodes.values()], links: finalLinks, truncated: nodes.size >= MAX_NODES };
}
