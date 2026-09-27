// Memory: one fact per Markdown file in flowrail/memory/, plus a deterministic recall (BM25, no model).
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, stringifyFrontmatter, wikilinks } from './frontmatter.js';
import { listFiles, writeText, localDate, moveToTrash, slugify, readText } from 'flowrail/api';
import { listDocs, headings } from './docs.js';

export const TYPES = ['user', 'feedback', 'project', 'reference'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

/**
 * The memory every page reads and writes: a plugin's store when one is set (`stores.memory`), else
 * flowrail/memory/. A store answers list(), recall(question, limit) and store(m); trash(name) is
 * optional. A memory whose `path` is null lives outside the repo and has no Docs link.
 */
export function memoryFor(p) {
  if (p.stores?.memory) return p.stores.memory;
  return { list: () => list(p), recall: (q, n) => recall(p, q, n), store: (m) => store(p, m), trash: (name) => trash(p, name) };
}

export function list(p) {
  return listFiles(p.memory, '.md').filter((f) => f !== 'INDEX.md').map((file) => {
    const text = readText(path.join(p.memory, file));
    const { data, body } = parseFrontmatter(text);
    return {
      name: data.name || file.replace(/\.md$/, ''),
      type: TYPES.includes(data.type) ? data.type : 'reference',
      description: data.description || firstLine(body),
      created: data.created || '',
      ...(data.seed === true || data.seed === 'true' ? { seed: true } : {}),
      body: body.trim(),
      links: wikilinks(body),
      path: `flowrail/memory/${file}`,
    };
  });
}

const firstLine = (s) => String(s).trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 200);

export function rebuildIndex(p) {
  const items = list(p);
  const byType = TYPES.map((t) => [t, items.filter((i) => i.type === t)]).filter(([, xs]) => xs.length);
  const lines = ['# Memory index', '', 'One line per memory. Maintained by `npx @finalangel/flowrail-os remember`; edit the memory files, not this list.', ''];
  for (const [type, xs] of byType) {
    lines.push(`## ${type}`, '');
    for (const i of xs) lines.push(`- [${i.name}](${i.name}.md): ${i.description}`);
    lines.push('');
  }
  writeText(p.memoryIndex, lines.join('\n'));
}

/**
 * Store one fact. Refuses to overwrite unless force.
 * @param {{name?:string, type:string, description?:string, body?:string, fact?:string, why?:string, how?:string, force?:boolean}} m
 */
export function store(p, m) {
  const type = String(m.type || '').toLowerCase();
  if (!TYPES.includes(type)) throw bad(`type must be one of ${TYPES.join(', ')}`);
  const fact = String(m.fact || m.description || '').trim();
  if (!fact && !m.body) throw bad('the fact is required');
  const name = m.name ? String(m.name) : slugify(fact, 40);
  if (!NAME_RE.test(name)) throw bad('name must be a lowercase slug (letters, digits, dashes)');
  const file = path.join(p.memory, `${name}.md`);
  if (fs.existsSync(file) && !m.force) throw bad(`memory "${name}" already exists; use --force to overwrite`, 409);
  const description = (m.description || fact || firstLine(m.body)).replace(/\s+/g, ' ').slice(0, 300);
  let body = m.body ? String(m.body).trim() : fact;
  if (m.why) body += `\n\n**Why:** ${m.why}`;
  if (m.how) body += `\n\n**How to apply:** ${m.how}`;
  writeText(file, stringifyFrontmatter({ name, type, description, created: localDate() }) + '\n' + body + '\n');
  rebuildIndex(p);
  return list(p).find((i) => i.name === name);
}

export function trash(p, name) {
  if (!NAME_RE.test(String(name))) throw bad('invalid memory name');
  const file = path.join(p.memory, `${name}.md`);
  if (!fs.existsSync(file)) throw bad(`no memory "${name}"`, 404);
  moveToTrash(p.root, file);
  rebuildIndex(p);
  return { name };
}

// ---------- recall ----------

const STOP = new Set('a an and are as at be but by can did do does for from had has have how i if in into is it its me my of on or our should so that the their them then there these they this to was we were what when where which who why will with you your about after before any all not no than'.split(' ').filter((w) => w !== 'when'));

export function tokenize(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t.length > 1 && !STOP.has(t)).map(stem);
}

/**
 * Light stemming, enough that release/releases/released/releasing and ship/shipping meet:
 * drop -ing/-ed/-s (and -es after s, x, z, ch, sh), undouble a final consonant, drop a final e.
 * Not Porter; add a real stemmer if recall misses on word forms in practice.
 */
export function stem(t) {
  let s = t;
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 4 && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !/(ss|us|is)$/.test(s)) s = s.slice(0, -1);
  if (s !== t && /([^aeiouls])\1$/.test(s)) s = s.slice(0, -1);
  if (s.length > 4 && s.endsWith('e')) s = s.slice(0, -1);
  return s;
}

// A few words people ask with that the notes rarely use. Kept tiny and deterministic on purpose.
const SYNONYMS = [
  'deploy release ship publish launch',
  'schedule when day cadence weekly monday tuesday wednesday thursday friday saturday sunday',
  'package manager npm pnpm yarn bun',
  'test spec',
].map((g) => g.split(' ').map(stem));

/** Query term -> the other stems that count for it (at a discount). */
function variants(t) {
  const out = new Set();
  for (const g of SYNONYMS) if (g.includes(t)) for (const x of g) if (x !== t) out.add(x);
  return [...out];
}

/** Units to rank: every memory, and every heading section of every Markdown doc. */
function corpus(p) {
  const units = [];
  for (const m of list(p)) {
    units.push({ source: 'memory', name: m.name, path: m.path, title: m.description, text: `${m.name.replace(/-/g, ' ')} ${m.description} ${m.description} ${m.body}`, body: m.body, boost: 1.3 });
  }
  for (const rel of listDocs(p.root, 1500)) {
    if (!/\.(md|markdown)$/i.test(rel) || rel.startsWith('flowrail/memory/')) continue;
    const text = readText(path.join(p.root, rel));
    if (text.length > 512 * 1024) continue;
    const rows = text.split('\n');
    const hs = headings(text);
    const cuts = hs.length ? hs : [{ level: 1, text: path.basename(rel), line: 1 }];
    cuts.forEach((h, i) => {
      const end = i + 1 < cuts.length ? cuts[i + 1].line - 1 : rows.length;
      const section = rows.slice(h.line, end).join('\n').slice(0, 1500);
      units.push({ source: 'doc', path: rel, name: rel, title: h.text, heading: h.text, text: `${h.text} ${h.text} ${rel.replace(/[/._-]+/g, ' ')} ${section}`, body: section, boost: 1 });
    });
  }
  return units;
}

/**
 * Rank memories and doc sections against a question. Deterministic; no model call.
 * @returns {{source:'memory'|'doc', name:string, path:string, heading?:string, score:number, snippet:string}[]}
 */
export function recall(p, question, limit = 8) {
  const q = [...new Set(tokenize(question))];
  if (!q.length) return [];
  const units = corpus(p).map((u) => ({ ...u, tokens: tokenize(u.text) }));
  const N = units.length || 1;
  const avg = units.reduce((s, u) => s + u.tokens.length, 0) / N || 1;
  const df = (t) => units.filter((u) => u.tokens.includes(t)).length;
  const k1 = 1.2;
  const b = 0.75;
  // Each query term counts once: its own best match, or a synonym's at 0.7 of the weight.
  const groups = q.map((t) => [[t, 1], ...variants(t).map((v) => [v, 0.7])].map(([term, w]) => ({ term, w, df: df(term) })));
  const scored = [];
  for (const u of units) {
    let score = 0;
    let matched = 0;
    for (const g of groups) {
      let best = 0;
      for (const { term, w, df: n } of g) {
        const tf = u.tokens.filter((x) => x === term).length;
        if (!tf) continue;
        const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
        best = Math.max(best, w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * u.tokens.length) / avg))));
      }
      if (best) { matched++; score += best; }
    }
    if (!score) continue;
    score *= u.boost * (0.6 + 0.4 * (matched / q.length));
    scored.push({ source: u.source, name: u.name, path: u.path, ...(u.heading ? { heading: u.heading } : {}), title: u.title, score: Math.round(score * 1000) / 1000, snippet: snippet(u.body, groups.flatMap((g) => g.map((x) => x.term))) });
  }
  return scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

function snippet(body, q) {
  const lines = String(body).split('\n').map((l) => l.trim()).filter(Boolean);
  let best = lines[0] || '';
  let bestN = -1;
  for (const l of lines) {
    const toks = new Set(tokenize(l));
    const n = q.filter((t) => toks.has(t)).length;
    if (n > bestN) { best = l; bestN = n; }
  }
  return best.length > 220 ? best.slice(0, 217) + '...' : best;
}
