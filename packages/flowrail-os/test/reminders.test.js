import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseDay, dated, duties, periodOf, reminders, attentionOf } from '../src/core/reminders.js';
import * as docsMod from '../src/core/docs.js';
import { workspace } from './helpers.js';

const TODAY = new Date(2026, 8, 27); // 27 September 2026

test('dates: only real YYYY-MM-DD values', () => {
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDay('soon'), null);
  assert.equal(parseDay('"2026-10-01"').getDate(), 1);
});

test('frontmatter dates within the window, overdue first; outside docsRoots is never read', () => {
  const p = workspace();
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true }); fs.writeFileSync(path.join(p.root, rel), text); };
  w('docs/a.md', '---\ndue: 2026-09-20\n---\n# Renew the domain\n');
  w('docs/b.md', '---\nnext_date: 2026-09-30\n---\n# Call back\n');
  w('docs/c.md', '---\ndue: 2026-12-01\n---\n# Later\n');
  w('docs/d.md', '---\nrenewal_date: 2026-09-28\n---\n# Renewal\n');
  w('.hidden/e.md', '---\ndue: 2026-09-01\n---\n# Hidden\n');
  const got = dated(p.root, {}, TODAY);
  assert.deepEqual(got.map((r) => [r.path, r.days, r.overdue]), [['docs/a.md', -7, true], ['docs/b.md', 3, false]]);
  assert.equal(got[0].title, 'Renew the domain');
  const custom = dated(p.root, { reminders: { fields: ['renewal_date'], within: 1 } }, TODAY);
  assert.deepEqual(custom.map((r) => r.path), ['docs/d.md']);
  docsMod.setRoots(p.root, ['docs/b.md']);
  try { assert.deepEqual(dated(p.root, { reminders: { within: 8 } }, new Date(2026, 8, 26)).map((r) => r.path), ['docs/b.md']); }
  finally { docsMod.setRoots(p.root, null); }
});

test('duties: named by period, open until a Done task has the name, overdue after the grace days', () => {
  assert.equal(periodOf('quarter', TODAY).label, 'Q3/2026');
  assert.equal(periodOf('year', TODAY).label, '2026');
  const cfg = { duties: [{ name: 'Monthly close', every: 'month', due: 7 }, { name: 'VAT return', every: 'quarter', due: 60 }, { name: 'Bad', every: 'week' }] };
  const open = duties(cfg, [], TODAY);
  assert.deepEqual(open.map((d) => [d.name, d.dueDate, d.overdue]), [['VAT return Q2/2026', '2026-08-29', true], ['Monthly close August 2026', '2026-09-07', true]]);
  const cleared = duties(cfg, [{ title: 'Monthly close August 2026 (books)', status: 'Done' }, { title: 'VAT return Q2/2026', status: 'Todo' }], TODAY);
  assert.deepEqual(cleared.map((d) => d.name), ['VAT return Q2/2026']);
  const since = duties({ duties: [{ name: 'Monthly close', every: 'month', due: 7, from: '2026-06-01' }] }, [{ title: 'Monthly close July 2026', status: 'Done' }], TODAY);
  assert.deepEqual(since.map((d) => d.name).sort(), ['Monthly close August 2026', 'Monthly close June 2026']);
});

test('reminders read the board through its store and become Needs-you lines', () => {
  const p = workspace();
  p.stores = { board: { read: () => ({ config: {}, tasks: [{ title: 'Monthly close August 2026', status: 'Done' }] }) } };
  const r = reminders(p, { duties: [{ name: 'Monthly close', every: 'month', due: 7 }] }, TODAY);
  assert.equal(r.items.length, 0);
  const line = attentionOf({ kind: 'duty', name: 'VAT return Q2/2026', days: -3, overdue: true });
  assert.equal(line.severity, 'warn');
  assert.match(line.title, /overdue 3 d/);
});

test('duties: weekdays, a fixed day, a lead time, month names in a locale, match patterns and notes', async () => {
  const { duties } = await import('../src/core/reminders.js');
  const today = new Date(2026, 8, 25); // 25 Sept 2026
  const config = { reminders: { locale: 'de-CH' }, duties: [
    { name: 'Monatsabschluss', every: 'month', due: 5, weekdays: true, lead: 14, from: '2026-09-01', note: '{month_en} close', doc: 'docs/finance.md',
      match: ['monatsabschluss', '({month}|{month_en}|{year}-{mm})', '{year}'] },
    { name: 'VAT return', every: 'quarter', due: 60, lead: 30, from: '2026-01-01' },
    { name: 'Annual report', every: 'year', dueOn: '06-30', lead: 30, from: '2026-01-01' },
  ] };
  const names = (tasks, day = today) => duties(config, tasks, day).map((d) => `${d.name} ${d.dueDate}`);
  // September's close is due five weekdays after 30 Sept (skipping the weekend) and shows 14 days ahead.
  assert.deepEqual(names([]), ['VAT return Q1/2026 2026-05-30', 'VAT return Q2/2026 2026-08-29', 'Monatsabschluss September 2026 2026-10-07']);
  assert.equal(duties(config, [], new Date(2026, 8, 22)).some((d) => d.name.startsWith('Monatsabschluss')), false, 'not yet within the lead time');
  const close = duties(config, [], today).find((d) => d.name.startsWith('Monatsabschluss'));
  assert.deepEqual([close.note, close.doc], ['September close', 'docs/finance.md']);
  // A Done task clears it by its name, or by all the match patterns.
  assert.equal(names([{ title: 'Close: Monatsabschluss 2026-09 done 2026', status: 'Done' }]).some((n) => n.startsWith('Monatsabschluss')), false);
  assert.equal(names([{ title: 'Monatsabschluss August 2026', status: 'Done' }]).some((n) => n.startsWith('Monatsabschluss')), true);
  // Month names follow the locale; a fixed day falls in the year after a yearly period.
  const march = duties({ reminders: { locale: 'de-CH' }, duties: [{ name: 'Abschluss', every: 'month', from: '2027-03-01' }] }, [], new Date(2027, 3, 2));
  assert.equal(march[0].name, 'Abschluss März 2027');
  assert.deepEqual(duties(config, [], new Date(2027, 5, 5)).filter((d) => d.name.startsWith('Annual')).map((d) => [d.name, d.dueDate]), [['Annual report 2026', '2027-06-30']]);
});
