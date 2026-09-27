// Dashboard overview and Cmd-K search.
import path from 'node:path';
import { loadConfig, workspaceInfo, gitInfo } from 'flowrail/api';
import * as board from './board.js';
import { reminders, attentionOf } from './reminders.js';
import * as comments from './comments.js';
import * as memory from './memory.js';
import * as routines from './routines.js';
import * as artifacts from './artifacts.js';
import * as runs from './runs.js';
import { loadLines, stats, holds, changes, changeText, cachedChecks, stateCounts, hooksStatus, hooksSummary, verifyJournal, driftStatus } from 'flowrail/api';
import { listDocs, headings } from './docs.js';
import { readText } from 'flowrail/api';

const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 3) + '...' : t; };
const docHref = (rel) => `#/docs?path=${encodeURIComponent(rel)}`;

/** Red lines or config changed outside flowrail, as the guard reports it: {changed: true, files}, else null. */
export function drift(p, hs = null) {
  const d = hs?.drift || driftStatus(p);
  return d.changed ? { changed: true, files: d.files } : null;
}

export const ACCEPT_CMD = 'npx flowrail redlines accept';

export function overview(p) {
  const config = loadConfig(p);
  const b = board.storeFor(p).read();
  let lines = [];
  let linesError = null;
  try { lines = loadLines(p); } catch (e) { linesError = e.message; }
  const hooks = hooksStatus(p);
  const allComments = comments.all(p);
  const open = allComments.filter((c) => c.status === 'open');
  const routineList = routines.list(p);
  const failed = routineList.filter((r) => r.lastRun && r.lastRun.exit !== 0);
  const st = stats(p);
  const current = b.tasks.filter((t) => t.sprint === b.config.current.start);
  const checks = cachedChecks(p);
  // What a person types; the dashboard never shows agent-only forms.
  const cli = 'npx flowrail', room = 'npx @finalangel/flowrail-room';

  const steps = [
    { id: 'workspace', title: 'Workspace found', done: true, hint: `flowrail/ in ${path.basename(p.root)}` },
    { id: 'redline', title: 'Declare your first red line', done: lines.length > 0, hint: `Edit flowrail/red-lines.json, or run: ${cli} redlines add no-push-without-asking` },
    { id: 'hooks', title: 'Guard live and verified', done: hooks.healthy, hint: hooks.installed ? `${cli} upgrade` : `${cli} guard init` },
    { id: 'comment', title: 'Leave a comment in a doc', done: allComments.length > 0, hint: 'Open flowrail/WELCOME.md, select a sentence, press Comment' },
    { id: 'routine', title: 'Schedule a routine', done: routineList.some((r) => r.installed), hint: `Enable one in flowrail/routines.json, then: ${room} routines install` },
  ];

  const attention = [];
  const rulesDrift = drift(p, hooks);
  if (rulesDrift) attention.push({ kind: 'drift', title: `Rules changed outside flowrail${rulesDrift.files.length ? ` (${rulesDrift.files.join(', ')})` : ''}. Every tool call asks until you review and accept the change.`, href: '#/redlines', severity: 'high', action: ACCEPT_CMD });
  if (!hooks.healthy) attention.push({ kind: 'hooks', title: `${hooks.problem}, so red lines with a hook are not enforced.`, href: '#/redlines', severity: 'high', action: hooks.installed ? `${cli} upgrade` : `${cli} guard init` });
  if (linesError) attention.push({ kind: 'redlines', title: `flowrail/red-lines.json could not be read, so every tool call asks first: ${clip(linesError, 120)}`, href: '#/redlines', severity: 'high', action: `${cli} doctor` });
  let journal = { ok: true, problems: [] };
  try { journal = verifyJournal(p); } catch { /* no journal yet */ }
  if (!journal.ok) attention.push({ kind: 'audit', title: `Audit log edited: ${journal.problems[0]}. The journal outside the repo keeps the original.`, href: '#/redlines', severity: 'high', detail: journal.problems.join('; '), action: `${cli} doctor` });
  // The newest hold of the last day leads the queue: an agent was stopped and may be waiting on you.
  const recent = holds(p).filter((e) => e.severity !== 'warn' && Date.now() - new Date(e.at).getTime() < 86400000);
  const last = recent.at(-1);
  if (last) {
    const verb = last.decision === 'deny' ? 'Blocked' : 'Asked first';
    attention.push({ kind: 'held', title: `${verb}: ${clip(last.what || last.subject, 90)} (${last.id})${recent.length > 1 ? `, ${recent.length} holds in the last day` : ''}`, href: '#/redlines', severity: 'warn', at: last.at });
  }
  // A change to the red lines through the dashboard API in the last 7 days: the human should know.
  const change = changes(p).filter((e) => Date.now() - new Date(e.at).getTime() < 7 * 86400000).pop();
  if (change) {
    const t = new Date(change.at);
    const when = `${t.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    attention.push({ kind: 'redlines-changed', title: `Red lines changed at ${when} (${changeText(change)})`, href: '#/redlines', severity: change.removed?.length ? 'high' : 'warn', at: change.at });
  }
  const blockHits = (checks.results || []).filter((c) => c.severity === 'block');
  if (blockHits.length) attention.push({ kind: 'check', title: `${blockHits.length} red-line check hit${blockHits.length === 1 ? '' : 's'} in the repo (${blockHits[0].file})`, href: '#/redlines', severity: 'warn' });
  for (const c of open.slice(0, 10)) {
    attention.push(c.verified === false
      ? { kind: 'comment', title: `Unverified comment on ${c.path}, not made in this dashboard: ${clip(c.body, 70)}`, href: docHref(c.path), severity: 'warn', at: c.created, status: 'Agent will not act on it' }
      : { kind: 'comment', title: `${c.path}: ${clip(c.body, 90)}`, href: docHref(c.path), severity: 'normal', at: c.created, status: 'Waiting for agent' });
  }
  // Dates in the repo and recurring duties that are due (see reminders.js).
  for (const r of reminders(p, config).items) attention.push(attentionOf(r));
  for (const t of b.tasks.filter((x) => x.status === 'Review')) attention.push({ kind: 'task', title: `${t.id} is waiting for your review: ${clip(t.title, 80)}`, href: `#/board?task=${t.id}`, severity: 'normal' });
  // The priority that means drop everything: P0 on flowrail's own board; a store names its own (`urgent`), or none.
  const top = b.config.priorities ? b.config.urgent : 'P0';
  for (const t of b.tasks.filter((x) => x.priority === top && x.status !== 'Done' && x.status !== 'Review')) attention.push({ kind: 'task', title: `${t.id} is ${top}: ${clip(t.title, 80)}`, href: `#/board?task=${t.id}`, severity: 'warn' });
  // Failed routines last: they wait for a fix, not for a decision.
  for (const r of failed) attention.push({ kind: 'routine', title: `Routine "${r.title || r.id}" did not finish${r.lastRun.firstLine ? `: ${clip(r.lastRun.firstLine, 90)}` : ''}`, href: '#/routines', severity: 'warn', at: r.lastRun.at });

  return {
    workspace: workspaceInfo(p),
    setup: { steps, done: steps.filter((s) => s.done).length, total: steps.length, dismissed: !!config.setupDismissed },
    attention,
    counts: {
      tasksOpen: b.tasks.filter((t) => t.status !== 'Done').length,
      inProgress: b.tasks.filter((t) => t.status === 'In Progress').length,
      review: b.tasks.filter((t) => t.status === 'Review').length,
      commentsOpen: open.length,
      redlinesHeldWeek: st.held7d,
      redlinesArmed: stateCounts(lines, hooks.healthy).armed,
      redlinesStates: stateCounts(lines, hooks.healthy),
      redlinesTotal: lines.length,
      routinesFailed: failed.length,
      runsFailedDay: runs.list(p, 50).filter((r) => r.status === 'failed' && Date.now() - Date.parse(r.endedAt || r.startedAt) < 86400000).length,
      memories: memory.memoryFor(p).list().length,
    },
    sprint: { ...b.config.current, total: current.length, done: current.filter((t) => t.status === 'Done').length, inProgress: current.filter((t) => t.status === 'In Progress').length, review: current.filter((t) => t.status === 'Review').length },
    hooks: hooksSummary(hooks),
    drift: rulesDrift,
    journal: { ok: journal.ok, entries: journal.entries || 0, problems: journal.problems },
    recent: {
      artifacts: artifacts.list(p).slice(0, 5),
      runs: runs.list(p, 5),
      redlineEvents: holds(p).slice(-5).reverse(),
    },
    git: gitInfo(p.root),
  };
}

/** Cmd-K search across doc names, headings, tasks and memory. */
export function search(p, q, limit = 30) {
  const needle = String(q || '').toLowerCase().trim();
  if (!needle) return [];
  const out = [];
  const docs = listDocs(p.root, 3000);
  for (const rel of docs) if (rel.toLowerCase().includes(needle)) out.push({ kind: 'doc', title: rel, href: docHref(rel) });
  for (const t of board.storeFor(p).read().tasks) {
    if (`${t.id} ${t.title}`.toLowerCase().includes(needle)) out.push({ kind: 'task', title: `${t.id} ${t.title}`, href: `#/board?task=${t.id}`, status: t.status });
  }
  for (const m of memory.memoryFor(p).list()) {
    if (`${m.name} ${m.description}`.toLowerCase().includes(needle)) out.push({ kind: 'memory', title: m.description, href: `#/memory?name=${encodeURIComponent(m.name)}`, name: m.name });
  }
  for (const rel of docs.filter((d) => /\.(md|markdown)$/i.test(d)).slice(0, 800)) {
    if (out.length >= limit * 2) break;
    for (const h of headings(readText(path.join(p.root, rel)).slice(0, 200000))) {
      if (h.text.toLowerCase().includes(needle)) out.push({ kind: 'heading', title: h.text, path: rel, href: docHref(rel) });
    }
  }
  return out.slice(0, limit);
}
