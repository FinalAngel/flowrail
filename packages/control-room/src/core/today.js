// Today: what happened in this repo since this morning (or since a given time, for "While you
// were away"), from files flowrail already keeps. One line per item, newest first. Nothing here
// calls a model or the network. Starter content that init writes (seed: true) never shows.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readJsonl } from 'flowrail/api';
import * as board from './board.js';
import * as comments from './comments.js';
import * as artifacts from './artifacts.js';
import * as memory from './memory.js';
import { holds, changes, changeText } from 'flowrail/api';

const MAX = 50;

/** Local midnight today; before 06:00 the last 24 hours instead, so a late night still counts. */
export function sinceFor(now = new Date()) {
  if (now.getHours() < 6) return new Date(now.getTime() - 86400000);
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const who = (by) => (/^(agent|claude)$/i.test(String(by || '')) ? 'agent' : 'human');

function commits(root, since) {
  try {
    const log = execFileSync('git', ['log', `--since=${since.toISOString()}`, '--format=%h%x09%aI%x09%s', '-n', String(MAX)], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 });
    return log.split('\n').filter(Boolean).map((l) => {
      const [hash, at, ...rest] = l.split('\t');
      return { hash, at: new Date(at).toISOString(), subject: rest.join('\t') };
    });
  } catch { return []; }
}

/** A caller-supplied start (ISO string), clamped to the last 30 days; null when absent or invalid. */
export function parseSince(value, now = new Date()) {
  if (!value) return null;
  const d = new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const floor = new Date(now.getTime() - 30 * 86400000);
  return d < floor ? floor : d > now ? now : d;
}

/**
 * @param {{since?: Date|null}} [opts] start of the window; default this morning (sinceFor)
 * @returns {{since:string, items:{kind:string, title:string, detail?:string, at:string, href?:string, by?:string}[], counts:object}}
 */
export function today(p, now = new Date(), opts = {}) {
  const since = opts.since || sinceFor(now);
  const after = (iso) => iso && new Date(iso) >= since && new Date(iso) <= now;
  const items = [];
  const counts = { held: 0, tasksMoved: 0, tasksCreated: 0, commentsResolved: 0, artifacts: 0, routines: 0, commits: 0, memories: 0 };

  // Red lines held, one line per rule.
  const byRule = new Map();
  for (const e of holds(p)) {
    if (!after(e.at) || e.severity === 'warn') continue;
    counts.held++;
    const r = byRule.get(e.id) || { n: 0, at: e.at, last: e };
    r.n++;
    if (e.at >= r.at) { r.at = e.at; r.last = e; }
    byRule.set(e.id, r);
  }
  for (const [id, r] of byRule) {
    const verb = r.last.decision === 'deny' ? 'blocked' : 'asked first';
    items.push({ kind: 'held', title: `${id} held ${r.n}×`, detail: `last: ${verb}, ${r.last.what || String(r.last.subject || '').slice(0, 80)}`, at: r.at, href: '#/redlines', by: 'agent' });
  }
  for (const e of changes(p)) {
    if (!after(e.at)) continue;
    items.push({ kind: 'redlines-changed', title: `Red lines changed (${changeText(e)})`, detail: [...(e.removed || []).map((x) => `-${x}`), ...(e.added || []).map((x) => `+${x}`), ...(e.changed || []).map((x) => `~${x}`)].join(' '), at: e.at, href: '#/redlines' });
  }

  // Tasks: created (board.json) and moved (activity log).
  const b = board.storeFor(p).read();
  for (const t of b.tasks) {
    if (t.seed || !after(t.created)) continue;
    counts.tasksCreated++;
    items.push({ kind: 'task', title: `Filed ${t.id} ${t.title}`, at: t.created, href: `#/board?task=${t.id}`, by: who(t.createdBy) });
  }
  for (const e of readJsonl(p.activityLog)) {
    if (e.kind !== 'task' || !after(e.at)) continue;
    counts.tasksMoved++;
    items.push({ kind: 'task', title: `Moved ${e.id} to ${e.to}`, detail: e.title, at: e.at, href: `#/board?task=${e.id}`, by: who(e.by) });
  }

  for (const c of comments.all(p)) {
    if (c.status !== 'resolved' || !after(c.resolvedAt)) continue;
    counts.commentsResolved++;
    items.push({ kind: 'comment', title: `Resolved a comment on ${c.path}`, detail: c.resolveNote || c.body, at: c.resolvedAt, href: `#/docs?path=${encodeURIComponent(c.path)}`, by: who(c.resolvedBy) });
  }

  for (const a of artifacts.list(p)) {
    if (a.seed || !after(a.created)) continue;
    counts.artifacts++;
    items.push({ kind: 'artifact', title: `New report: ${a.title}`, at: a.created, href: `#/artifacts?name=${encodeURIComponent(a.name)}`, by: 'agent' });
  }

  for (const e of readJsonl(p.routinesLog)) {
    if (!after(e.at)) continue;
    counts.routines++;
    items.push({ kind: 'routine', title: `Routine ${e.id} ${e.exit === 0 ? 'ran' : `failed (exit ${e.exit})`}`, ...(e.firstLine ? { detail: e.firstLine } : {}), at: e.at, href: '#/routines', by: 'agent' });
  }

  for (const m of memory.list(p)) {
    if (m.seed) continue;
    let mtime;
    try { mtime = fs.statSync(path.join(p.root, m.path)).mtime.toISOString(); } catch { continue; }
    if (!after(mtime)) continue;
    counts.memories++;
    items.push({ kind: 'memory', title: `Remembered: ${m.description}`, at: mtime, href: `#/memory?name=${encodeURIComponent(m.name)}` });
  }

  for (const c of commits(p.root, since)) {
    if (!after(c.at)) continue;
    counts.commits++;
    items.push({ kind: 'commit', title: c.subject, detail: c.hash, at: c.at });
  }

  items.sort((a, b2) => String(b2.at).localeCompare(String(a.at)));
  return { since: since.toISOString(), items: items.slice(0, MAX), counts };
}
