// Sprint board in flowrail/board.json. A task's `sprint` is the start date of its sprint; "" is the backlog.
// Unfinished tasks from ended sprints roll into the current one on read, one priority higher.
import { readJson, writeJson, nowIso, parseDate, localDate, addDays, mondayOf, trashJson, appendLine, loadConfig } from 'flowrail/api';

export const STATUSES = ['Todo', 'In Progress', 'Review', 'Done'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

/** Sprint containing `today`, plus the next one. */
export function sprints(config, today = new Date()) {
  const len = Math.max(1, Number(config.sprintLength) || 14);
  const start0 = parseDate(config.sprintStart || mondayOf(today));
  const dayMs = 86400000;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const idx = Math.floor(Math.round((t - start0) / dayMs) / len);
  const make = (i) => {
    const start = addDays(start0, i * len);
    const end = addDays(start, len - 1);
    return { index: i + 1, start: localDate(start), end: localDate(end), label: `Sprint ${i + 1}`, range: `${fmt(start)} to ${fmt(end)}` };
  };
  return { sprintLength: len, current: make(idx), next: make(idx + 1), previous: make(idx - 1) };
}

export function labelFor(config, sprintDate) {
  const len = Math.max(1, Number(config.sprintLength) || 14);
  const start0 = parseDate(config.sprintStart || sprintDate);
  const i = Math.floor(Math.round((parseDate(sprintDate) - start0) / 86400000) / len);
  return `Sprint ${i + 1}`;
}

/**
 * The board every page, the overview and the Today feed read and write: a plugin's store when one
 * is set (see src/core/plugins.js, `stores.board`), else flowrail/board.json. A store answers
 * read() -> { config: { current, next, priorities?, groups? }, tasks }, create(fields),
 * update(id, fields, by), note(id, text, by) and trash(id).
 */
export function storeFor(p) {
  if (p.stores?.board) return p.stores.board;
  return {
    read: () => read(p, loadConfig(p)),
    create: (fields) => create(p, loadConfig(p), fields),
    update: (id, fields, by) => update(p, loadConfig(p), id, fields, by),
    note: (id, text, by) => note(p, id, text, by),
    trash: (id) => trash(p, id),
  };
}

export function load(p) {
  const b = readJson(p.board, { tasks: [] });
  if (!Array.isArray(b.tasks)) b.tasks = [];
  return b;
}

export function save(p, board) {
  writeJson(p.board, board);
}

const bump = (pr) => PRIORITIES[Math.max(0, PRIORITIES.indexOf(pr) - 1)] || 'P2';

/** Mutates board; returns number of tasks rolled over. */
export function rollover(board, config, today = new Date()) {
  const { current } = sprints(config, today);
  let n = 0;
  for (const t of board.tasks) {
    if (!t.sprint || t.status === 'Done' || t.sprint >= current.start) continue;
    const from = labelFor(config, t.sprint);
    t.sprint = current.start;
    t.priority = bump(t.priority);
    t.notes = [...(t.notes || []), { at: nowIso(), by: 'flowrail', text: `rolled over from ${from}` }];
    t.updated = nowIso();
    n++;
  }
  return n;
}

/** Read the board as the API returns it, rolling over (and saving) if needed. */
export function read(p, config, today = new Date()) {
  const board = load(p);
  if (rollover(board, config, today)) save(p, board);
  const s = sprints(config, today);
  // Every sprint the page can step through: the ones tasks sit in, plus the current and the next.
  const starts = [...new Set([...board.tasks.map((t) => t.sprint).filter(Boolean), s.current.start, s.next.start])].sort();
  const len = s.sprintLength;
  const list = starts.map((start) => ({ start, end: localDate(addDays(parseDate(start), len - 1)), label: labelFor(config, start) }));
  return { config: { sprintLength: len, current: s.current, next: s.next, sprints: list }, tasks: board.tasks };
}

export function resolveSprint(config, value, today = new Date()) {
  if (value === undefined || value === null) return undefined;
  const s = sprints(config, today);
  if (value === 'current') return s.current.start;
  if (value === 'next') return s.next.start;
  if (value === 'backlog' || value === '') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  throw bad(`sprint must be current, next, backlog or YYYY-MM-DD`);
}

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

function nextId(tasks) {
  const max = tasks.reduce((m, t) => Math.max(m, Number(String(t.id).replace(/\D/g, '')) || 0), 0);
  return `T-${String(max + 1).padStart(4, '0')}`;
}

function clean(fields, config) {
  const out = {};
  if (fields.title !== undefined) {
    const title = String(fields.title).trim();
    if (!title) throw bad('title is required');
    out.title = title.slice(0, 300);
  }
  if (fields.status !== undefined) {
    const s = STATUSES.find((x) => x.toLowerCase() === String(fields.status).toLowerCase().replace(/-/g, ' '));
    if (!s) throw bad(`status must be one of ${STATUSES.join(', ')}`);
    out.status = s;
  }
  if (fields.priority !== undefined) {
    const pr = String(fields.priority).toUpperCase();
    if (!PRIORITIES.includes(pr)) throw bad('priority must be P0, P1, P2 or P3');
    out.priority = pr;
  }
  if (fields.sprint !== undefined) out.sprint = resolveSprint(config, fields.sprint);
  if (fields.assignee !== undefined) out.assignee = String(fields.assignee).slice(0, 80);
  if (fields.labels !== undefined) out.labels = (Array.isArray(fields.labels) ? fields.labels : String(fields.labels).split(',')).map((l) => String(l).trim()).filter(Boolean).slice(0, 20);
  if (fields.due !== undefined) out.due = fields.due ? String(fields.due).slice(0, 10) : '';
  return out;
}

export function create(p, config, fields) {
  const board = load(p);
  const now = nowIso();
  const task = {
    id: nextId(board.tasks),
    title: '',
    status: 'Todo',
    priority: 'P2',
    sprint: '',
    assignee: '',
    labels: [],
    notes: [],
    createdBy: fields.createdBy === 'agent' ? 'agent' : 'human',
    created: now,
    updated: now,
    ...clean({ ...fields, title: fields.title ?? '' }, config),
  };
  board.tasks.push(task);
  save(p, board);
  return task;
}

function find(board, id) {
  const t = board.tasks.find((x) => x.id === id || x.id === `T-${String(id).padStart(4, '0')}`);
  if (!t) throw bad(`no task ${id}`, 404);
  return t;
}

/** by: 'agent' or 'human'; a status change is recorded in .flowrail/activity.log for the Today feed. */
export function update(p, config, id, fields, by = 'human') {
  const board = load(p);
  const t = find(board, id);
  const from = t.status;
  Object.assign(t, clean(fields, config), { updated: nowIso() });
  save(p, board);
  if (t.status !== from) {
    try { appendLine(p.activityLog, { at: t.updated, kind: 'task', id: t.id, title: t.title, from, to: t.status, by: by === 'agent' ? 'agent' : 'human' }); } catch { /* best effort */ }
  }
  return t;
}

export function note(p, id, text, by = 'you') {
  if (!text || !String(text).trim()) throw bad('note text is required');
  const board = load(p);
  const t = find(board, id);
  t.notes = [...(t.notes || []), { at: nowIso(), by: String(by).slice(0, 80), text: String(text).slice(0, 4000) }];
  t.updated = nowIso();
  save(p, board);
  return t;
}

export function trash(p, id) {
  const board = load(p);
  const t = find(board, id);
  board.tasks = board.tasks.filter((x) => x !== t);
  trashJson(p.root, `task-${t.id}`, t);
  save(p, board);
  return t;
}
