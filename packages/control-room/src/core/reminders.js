// Reminders: dates the repo already carries, and duties that come back every period.
//
// Dates: a Markdown file's frontmatter field named in config `reminders.fields` (default due and
// next_date) with a YYYY-MM-DD value is a reminder once it is overdue or due within
// `reminders.within` days (default 7). Only files Docs would show are read (listDocs, docsRoots).
// Duties: config `duties` [{ name, every: month|quarter|year, due: days, from? }]. Each period's
// instance is named with its period ("Monthly close September 2026", "VAT return Q3/2026",
// "Annual report 2026"), opens when the period ends and stays open until a Done task on the board
// has that name in its title; it is overdue `due` days after the period ends. Only the last ended
// period is shown, or every one since `from` (YYYY-MM-DD) when set.
import path from 'node:path';
import fs from 'node:fs';
import { listDocs } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import { titleOf } from './library.js';
import * as board from './board.js';

const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** A local date from YYYY-MM-DD, or null. */
export function parseDay(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v ?? '').trim().replace(/^["']|["']$/g, ''));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysUntil = (d, today) => Math.round((midnight(d) - midnight(today)) / DAY);

function head(abs) {
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(8192);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 8192, 0));
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const cache = new Map();
/** Dated reminders from frontmatter: [{ kind: 'due', path, title, field, date, days, overdue }]. */
export function dated(root, config = {}, today = new Date()) {
  const r = config.reminders || {};
  const fields = Array.isArray(r.fields) && r.fields.length ? r.fields.map(String) : ['due', 'next_date'];
  const within = Number.isFinite(+r.within) ? +r.within : 7;
  const key = `${root}\0${fields}\0${within}\0${iso(today)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.items;
  const items = [];
  for (const rel of listDocs(root).filter((f) => /\.(md|markdown)$/i.test(f))) {
    const text = head(path.join(root, rel));
    if (!text.startsWith('---')) continue;
    const { data } = parseFrontmatter(text);
    for (const field of fields) {
      const d = parseDay(data[field]);
      if (!d) continue;
      const days = daysUntil(d, today);
      if (days <= within) items.push({ kind: 'due', path: rel, title: titleOf(text, rel), field, date: iso(d), days, overdue: days < 0 });
    }
  }
  items.sort((a, b) => a.days - b.days || a.path.localeCompare(b.path));
  cache.set(key, { at: Date.now(), items });
  return items;
}

/** The period of `every` that contains `d`: { name, start, end } with its label ("September 2026"). */
export function periodOf(every, d) {
  const y = d.getFullYear(), m = d.getMonth();
  if (every === 'year') return { label: String(y), start: new Date(y, 0, 1), end: new Date(y, 11, 31) };
  if (every === 'quarter') { const q = Math.floor(m / 3); return { label: `Q${q + 1}/${y}`, start: new Date(y, q * 3, 1), end: new Date(y, q * 3 + 3, 0) }; }
  return { label: `${MONTHS[m]} ${y}`, start: new Date(y, m, 1), end: new Date(y, m + 1, 0) };
}

/** Open duty instances: [{ kind: 'duty', name, period, dueDate, days, overdue }]. `tasks` from the board. */
export function duties(config = {}, tasks = [], today = new Date()) {
  const done = tasks.filter((t) => t.status === 'Done').map((t) => String(t.title || '').toLowerCase());
  const out = [];
  for (const duty of Array.isArray(config.duties) ? config.duties : []) {
    if (!duty || typeof duty.name !== 'string' || !['month', 'quarter', 'year'].includes(duty.every)) continue;
    const from = parseDay(duty.from);
    const grace = Number.isFinite(+duty.due) ? +duty.due : 0;
    // Walk back from the period before today's: the last ended one, and older ones back to `from`.
    let p = periodOf(duty.every, new Date(periodOf(duty.every, today).start.getTime() - DAY));
    for (let i = 0; i < 36; i++) {
      const name = `${duty.name} ${p.label}`;
      if (!done.some((t) => t.includes(name.toLowerCase()))) {
        const dueDate = new Date(p.end.getFullYear(), p.end.getMonth(), p.end.getDate() + grace);
        const days = daysUntil(dueDate, today);
        out.push({ kind: 'duty', name, period: p.label, dueDate: iso(dueDate), days, overdue: days < 0 });
      }
      if (!from) break;
      p = periodOf(duty.every, new Date(p.start.getTime() - DAY));
      if (p.end < from) break;
    }
  }
  return out.sort((a, b) => a.days - b.days);
}

/** Everything due, for the API, the Dashboard's "Needs you" and Today. */
export function reminders(p, config, today = new Date()) {
  let tasks = [];
  try { tasks = board.storeFor(p).read().tasks; } catch { /* no board: duties stay open */ }
  return { items: [...dated(p.root, config, today), ...duties(config, tasks, today)].sort((a, b) => a.days - b.days) };
}

const when = (days) => (days < 0 ? `overdue ${-days} d` : days === 0 ? 'due today' : days === 1 ? 'due tomorrow' : `due in ${days} d`);
const docHref = (rel) => '#/docs?path=' + encodeURIComponent(rel);

/** A reminder as a "Needs you" line. */
export const attentionOf = (r) => (r.kind === 'duty'
  ? { kind: 'duty', title: `${r.name}: ${when(r.days)}`, detail: `file a task named "${r.name}" and mark it Done`, href: '#/board', severity: r.overdue ? 'warn' : 'normal' }
  : { kind: 'due', title: `${r.title}: ${when(r.days)}`, detail: `${r.field} ${r.date} · ${r.path}`, href: docHref(r.path), severity: r.overdue ? 'warn' : 'normal' });
