// Reminders: dates the repo already carries, and duties that come back every period.
//
// Dates: a Markdown file's frontmatter field named in config `reminders.fields` (default due and
// next_date) with a YYYY-MM-DD value is a reminder once it is overdue or due within
// `reminders.within` days (default 7). Only files Docs would show are read (listDocs, docsRoots).
// Duties: config `duties` [{ name, every: month|quarter|year, due: days, from? }]. Each period's
// instance is named with its period ("Monthly close September 2026", "VAT return Q3/2026",
// "Annual report 2026"), opens when the period ends and stays open until a Done task on the board
// has that name in its title; it is overdue `due` days after the period ends. Only the last ended
// period is shown, or every one since `from` (YYYY-MM-DD) when set. Optional: `weekdays: true`
// counts `due` in weekdays; `dueOn: "MM-DD"` is due on that day after the period ends instead;
// `lead: days` shows it that long before it is due (even while the period runs); `locale` names
// the months ("de-CH": "März 2026"); `match` is a list of patterns a Done task's title must all
// match to clear it too, with {month}, {month_en}, {mm}, {q} and {year} filled in; `note` (same
// placeholders) and `doc` (a repo path) travel with each instance.
import path from 'node:path';
import fs from 'node:fs';
import { listDocs } from './docs.js';
import { parseFrontmatter } from './frontmatter.js';
import { titleOf } from './library.js';
import * as board from './board.js';

const DAY = 86400000;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (locale, m) => {
  try { return new Intl.DateTimeFormat(locale, { month: 'long' }).format(new Date(2000, m, 1)); } catch { return MONTHS[m]; }
};
const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
export function periodOf(every, d, locale) {
  const y = d.getFullYear(), m = d.getMonth();
  const q = Math.floor(m / 3);
  const vars = { year: y, mm: String(m + 1).padStart(2, '0'), q: q + 1, month: locale ? monthName(locale, m) : MONTHS[m], month_en: MONTHS[m] };
  if (every === 'year') return { label: String(y), start: new Date(y, 0, 1), end: new Date(y, 11, 31), vars };
  if (every === 'quarter') return { label: `Q${q + 1}/${y}`, start: new Date(y, q * 3, 1), end: new Date(y, q * 3 + 3, 0), vars };
  return { label: `${vars.month} ${y}`, start: new Date(y, m, 1), end: new Date(y, m + 1, 0), vars };
}

const fill = (text, vars, quote = false) => String(text).replace(/\{(month_en|month|mm|q|year)\}/g, (_, k) => (quote ? esc(vars[k]) : String(vars[k])));

/** When a period's instance of a duty is due: `due` days (or weekdays) after its end, or on `dueOn`. */
function dueAfter(duty, end) {
  const on = /^(\d{2})-(\d{2})$/.exec(String(duty.dueOn || ''));
  if (on) {
    let d = new Date(end.getFullYear(), +on[1] - 1, +on[2]);
    if (d <= end) d = new Date(end.getFullYear() + 1, +on[1] - 1, +on[2]);
    return d;
  }
  const n = Number.isFinite(+duty.due) ? +duty.due : 0;
  if (!duty.weekdays) return new Date(end.getFullYear(), end.getMonth(), end.getDate() + n);
  const d = new Date(end);
  for (let left = n; left > 0;) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0 && d.getDay() !== 6) left--; }
  return d;
}

/** Open duty instances: [{ kind: 'duty', name, period, dueDate, days, overdue }]. `tasks` from the board. */
export function duties(config = {}, tasks = [], today = new Date()) {
  const doneTitles = tasks.filter((t) => t.status === 'Done').map((t) => String(t.title || ''));
  const done = doneTitles.map((t) => t.toLowerCase());
  const out = [];
  for (const duty of Array.isArray(config.duties) ? config.duties : []) {
    if (!duty || typeof duty.name !== 'string' || !['month', 'quarter', 'year'].includes(duty.every)) continue;
    const from = parseDay(duty.from);
    const locale = typeof duty.locale === 'string' ? duty.locale : config.reminders?.locale;
    const lead = Number.isFinite(+duty.lead) && duty.lead !== undefined ? +duty.lead : null;
    const match = Array.isArray(duty.match) ? duty.match.map(String) : [];
    // Walk back from the running period (only with a lead time, which may show it early) or from
    // the last ended one, to `from`; without `from`, the last ended period is the oldest shown.
    let p = periodOf(duty.every, today, locale);
    if (lead === null) p = periodOf(duty.every, new Date(p.start.getTime() - DAY), locale);
    let ended = 0;
    for (let i = 0; i < 400; i++) {
      if (from && p.end < from) break;
      const name = `${duty.name} ${p.label}`;
      const dueDate = dueAfter(duty, p.end);
      const days = daysUntil(dueDate, today);
      const shows = lead === null ? p.end < midnight(today) : days <= lead;
      const cleared = done.some((t) => t.includes(name.toLowerCase()))
        || (match.length > 0 && doneTitles.some((t) => match.every((m) => { try { return new RegExp(fill(m, p.vars, true), 'i').test(t); } catch { return false; } })));
      if (shows && !cleared) {
        out.push({ kind: 'duty', name, period: p.label, dueDate: iso(dueDate), days, overdue: days < 0,
          ...(duty.note ? { note: fill(duty.note, p.vars) } : {}), ...(typeof duty.doc === 'string' ? { doc: duty.doc } : {}) });
      }
      if (p.end < midnight(today)) ended++;
      if (!from && ended >= 1) break;
      p = periodOf(duty.every, new Date(p.start.getTime() - DAY), locale);
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
  ? { kind: 'duty', title: `${r.name}: ${when(r.days)}`, detail: r.note || `file a task named "${r.name}" and mark it Done`, href: r.doc ? docHref(r.doc) : '#/board', severity: r.overdue ? 'warn' : 'normal' }
  : { kind: 'due', title: `${r.title}: ${when(r.days)}`, detail: `${r.field} ${r.date} · ${r.path}`, href: docHref(r.path), severity: r.overdue ? 'warn' : 'normal' });
