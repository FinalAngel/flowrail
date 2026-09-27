import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { collections, list, move } from '../src/core/records.js';
import { workspace } from './helpers.js';

const p = workspace();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true }); fs.writeFileSync(path.join(p.root, rel), text); };
const ACME = '---\ncompany: Acme\nstatus: lead\nregion: CH\nnext_date: 2026-01-10\n---\n\n# Acme\n\nNotes stay exactly as they are.\n';
w('crm/acme.md', ACME);
w('crm/globex.md', '---\ncompany: Globex\nstatus: won\n---\nBody\n');
w('crm/README.md', '# not a record\n');
w('crm/.env.md', 'SECRET=1');
w('crm/notes.txt', 'not markdown');
w('other/x.md', '---\nstatus: lead\n---\n');
const col = { id: 'customers', title: 'Customers', dir: 'crm', status: { field: 'status', values: ['lead', 'talking', 'won'] }, columns: ['company', 'region'], filters: ['region'], due: 'next_date', titleField: 'company' };
fs.writeFileSync(p.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(p.config, 'utf8')), records: [col, { id: 'Bad Id', dir: 'x' }, { id: 'out', dir: '../x' }] }));
const s = await startServer({ root: p.root, port: 0 });
after(() => s.close());

const req = (method, url, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers: { Host: `127.0.0.1:${s.port}`, 'X-Flowrail-Token': s.token, ...(method === 'POST' ? { 'X-Flowrail': '1' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || 'null') }));
  });
  r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
});

test('config: valid collections kept, broken ones reported', () => {
  const { list, errors } = collections({ records: [col, { id: 'Bad Id', dir: 'x' }, { id: 'out', dir: '../x' }, col] });
  assert.deepEqual(list.map((c) => c.id), ['customers']);
  assert.equal(errors.length, 3);
  assert.deepEqual(list[0].status.board, ['lead', 'talking', 'won'], 'the board defaults to every value');
  assert.equal(list[0].group, 'Records');
});

test('lists the records in the folder with their fields; not READMEs, secrets or other files', async () => {
  const r = (await req('GET', '/api/records/customers')).json;
  assert.deepEqual(r.records.map((x) => x.name), ['acme', 'globex']);
  assert.equal(r.records[0].title, 'Acme');
  assert.equal(r.records[0].due, '2026-01-10');
  assert.equal(r.records[0].fields.region, 'CH');
  assert.deepEqual((await req('GET', '/api/records')).json.collections.map((c) => c.id), ['customers']);
});

test('a move rewrites exactly the status line and nothing else', async () => {
  const before = (await req('GET', '/api/records/customers')).json.records[0];
  const r = await req('POST', '/api/records/customers', { _action: 'move', path: 'crm/acme.md', status: 'talking', mtime: before.mtime });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(fs.readFileSync(path.join(p.root, 'crm/acme.md'), 'utf8'), ACME.replace('status: lead', 'status: talking'));
  assert.match(fs.readFileSync(p.activityLog, 'utf8'), /"kind":"record".*"to":"talking"/);
});

test('refuses a stale page, unknown values and paths outside the collection', async () => {
  assert.equal((await req('POST', '/api/records/customers', { _action: 'move', path: 'crm/acme.md', status: 'won', mtime: 1 })).status, 409);
  assert.equal((await req('POST', '/api/records/customers', { _action: 'move', path: 'crm/acme.md', status: 'closed' })).status, 400);
  for (const bad of ['other/x.md', 'crm/../other/x.md', 'crm/.env.md', 'crm/notes.txt', 'crm/sub/y.md']) {
    const r = await req('POST', '/api/records/customers', { _action: 'move', path: bad, status: 'won' });
    assert.ok(r.status >= 400, `${bad} -> ${r.status}`);
  }
  assert.equal(fs.readFileSync(path.join(p.root, 'other/x.md'), 'utf8'), '---\nstatus: lead\n---\n');
});

test('the settings API cannot set records', async () => {
  await req('POST', '/api/config', { records: [{ id: 'evil', dir: '.' }], name: 'x' });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.config, 'utf8')).records.map((c) => c.id), ['customers', 'Bad Id', 'out']);
});

test('a collection may cap its files, name bands and rates, rich columns, and be read-only', () => {
  const [c] = collections({ records: [{ ...col, id: 'leads', limit: 5000, readOnly: true, titleLabel: 'Company',
    columns: ['region', { field: 'contact', label: 'Contact', sub: 'role' }, { field: 'bad field!' }],
    status: { values: ['lead', 'talking', 'won', 'lost'], bands: [{ label: 'open', values: ['lead', 'talking'], tone: 'info' }, { label: 'nothing', values: ['nope'] }],
      rates: [{ label: 'win rate', count: ['won'], over: ['won', 'lost'] }, { label: 'broken', count: [], over: ['won'] }] } }] }).list;
  assert.equal(c.limit, 5000);
  assert.equal(c.readOnly, true);
  assert.equal(c.titleLabel, 'Company');
  assert.deepEqual(c.columns, [{ field: 'region' }, { field: 'contact', label: 'Contact', sub: 'role' }]);
  assert.deepEqual(c.status.bands, [{ label: 'open', values: ['lead', 'talking'], tone: 'info' }]);
  assert.deepEqual(c.status.rates, [{ label: 'win rate', count: ['won'], over: ['won', 'lost'] }]);
  assert.equal(collections({ records: [{ ...col, limit: 10 ** 9 }] }).list[0].limit, 20000);
  assert.equal(collections({ records: [col] }).list[0].limit, 2000);
});

test('a read-only collection refuses moves; a limit caps the files read', () => {
  const [ro] = collections({ records: [{ ...col, readOnly: true }] }).list;
  assert.throws(() => move(p, ro, 'crm/acme.md', 'won'), (e) => e.status === 405);
  const [one] = collections({ records: [{ ...col, id: 'one', limit: 1 }] }).list;
  const r = list(p.root, one, 0);
  assert.equal(r.records.length, 1);
  assert.equal(r.truncated, true);
});
