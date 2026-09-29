import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { validate, fromConfig } from '../src/core/plugins.js';
import { workspace, tmpdir } from './helpers.js';

const p = workspace();
const ui = tmpdir();
fs.writeFileSync(path.join(ui, 'leads.js'), 'export function mount() {}');
fs.writeFileSync(path.join(ui, 'theme.css'), ':root { --accent: #F55068; }');
fs.writeFileSync(path.join(p.root, 'secret.txt'), 'no');
const seen = [];
const crm = {
  id: 'crm',
  ui,
  pages: [{ id: 'leads', title: 'Leads', path: '/leads', group: 'Sales', icon: 'board', module: 'leads.js' }],
  routes: {
    'GET leads': (_b, q) => ({ leads: [q.get('n')] }),
    'POST leads': (b, _q, ctx) => { seen.push([b, ctx.root]); return { ok: true }; },
  },
  styles: ['theme.css'],
};
const s = await startServer({ root: p.root, port: 0, plugins: [crm] });
after(() => s.close());

function req(method, url, { token = s.token, csrf = true, body } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `127.0.0.1:${s.port}`, ...(token ? { 'X-Flowrail-Token': token } : {}), ...(method === 'POST' && csrf ? { 'X-Flowrail': '1' } : {}) };
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { /* text */ } resolve({ status: res.statusCode, headers: res.headers, data, json }); });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

test('the page learns the plugin pages', async () => {
  const r = await req('GET', '/api/plugins');
  assert.deepEqual(r.json, [{ id: 'crm', aliases: {}, pages: [{ id: 'crm:leads', title: 'Leads', path: '/leads', group: 'Sales', icon: 'board', module: '/x/crm/leads.js' }] }]);
});

test('plugin routes sit behind the same token and CSRF checks', async () => {
  assert.deepEqual((await req('GET', '/api/x/crm/leads?n=7')).json, { leads: ['7'] });
  assert.equal((await req('GET', '/api/x/crm/leads', { token: null })).status, 401);
  assert.equal((await req('POST', '/api/x/crm/leads', { csrf: false, body: {} })).status, 403);
  assert.equal((await req('POST', '/api/x/crm/leads', { body: { a: 1 } })).status, 200);
  assert.deepEqual(seen, [[{ a: 1 }, p.root]]);
  assert.equal((await req('GET', '/api/x/other/leads')).status, 404);
});

test('plugin files are served from its ui folder and nowhere else', async () => {
  const ok = await req('GET', '/x/crm/leads.js', { token: null });
  assert.equal(ok.status, 200);
  assert.match(ok.headers['content-type'], /javascript/);
  assert.match(ok.headers['content-security-policy'], /default-src 'self'/);
  for (const bad of ['/x/crm/../../secret.txt', '/x/crm/%2e%2e/secret.txt', '/x/nope/leads.js', '/x/crm/']) assert.equal((await req('GET', bad, { token: null })).status, 404, bad);
});

test('plugin stylesheets are in the page from the first paint, after app.css', async () => {
  const html = (await req('GET', '/', { token: null })).data;
  const link = html.indexOf('<link rel="stylesheet" href="x/crm/theme.css">');
  assert.ok(link > html.indexOf('ui/app.css'), 'linked after app.css');
  assert.ok(link < html.indexOf('</head>'));
  const css = await req('GET', '/x/crm/theme.css', { token: null });
  assert.equal(css.status, 200);
  assert.match(css.headers['content-type'], /text\/css/);
});

test('a malformed plugin is refused before the server starts', async () => {
  assert.throws(() => validate({ id: 'Bad' }), /id must match/);
  assert.throws(() => validate({ id: 'a', routes: { 'DELETE x': () => {} } }), /route/);
  assert.throws(() => validate({ id: 'a', routes: { 'GET ../x': () => {} } }), /route/);
  assert.throws(() => validate({ id: 'a', ui: 'rel', pages: [] }), /absolute/);
  assert.throws(() => validate({ id: 'a', ui, pages: [{ id: 'x', title: 'X', path: '/x', module: '../x.js' }] }), /module/);
  for (const bad of ['../x.css', 'x.js', 'a"><script>.css', '/abs.css']) assert.throws(() => validate({ id: 'a', ui, styles: [bad] }), /style/, bad);
  assert.throws(() => validate({ id: 'a', styles: ['theme.css'] }), /style/, 'styles need ui');
  await assert.rejects(startServer({ root: p.root, port: 0, plugins: [crm, crm] }), /twice/);
});

test('config plugins load from inside the repo only', async () => {
  fs.writeFileSync(path.join(p.root, 'room.mjs'), "export default { id: 'local', routes: { 'GET hi': () => 'hi' } };");
  assert.equal((await fromConfig(p.root, ['room.mjs']))[0].id, 'local');
  await assert.rejects(fromConfig(p.root, ['../x.mjs']), /outside the repo/);
});

test('a plugin store backs the board, the overview and search', async () => {
  const calls = [];
  const tasks = [{ id: 'X-1', title: 'From the store', status: 'In Progress', priority: 'High', sprint: '2026-01-05', group: 'Sales', notes: [] }];
  const store = {
    read: () => ({ config: { current: { start: '2026-01-05', end: '2026-01-18', label: 'Wk2' }, priorities: ['High', 'Mid', 'Low'], groups: [{ name: 'Sales' }], source: 'data/tasks.json' }, tasks }),
    create: (f) => { calls.push(['create', f.title]); return { id: 'X-2', ...f }; },
    update: (id, f, by) => { calls.push(['update', id, f.status, by]); return { id, ...f }; },
    note: (id, text) => { calls.push(['note', id, text]); return { id }; },
    trash: (id) => { calls.push(['trash', id]); return { ok: true }; },
  };
  const s2 = await startServer({ root: p.root, port: 0, plugins: [{ id: 'tasks', stores: { board: store } }] });
  try {
    const r = (method, url, body) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: s2.port, method, path: url, headers: { Host: `127.0.0.1:${s2.port}`, 'X-Flowrail-Token': s2.token, ...(method === 'POST' ? { 'X-Flowrail': '1' } : {}) } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(JSON.parse(d))); });
      q.on('error', reject); if (body) q.write(JSON.stringify(body)); q.end();
    });
    assert.equal((await r('GET', '/api/board')).tasks[0].id, 'X-1');
    await r('POST', '/api/board', { _action: 'create', title: 'New' });
    await r('POST', '/api/board', { _action: 'update', id: 'X-1', status: 'Done' });
    assert.deepEqual(calls, [['create', 'New'], ['update', 'X-1', 'Done', 'human']]);
    const ov = await r('GET', '/api/overview');
    assert.equal(ov.counts.inProgress, 1);
    assert.equal((await r('GET', '/api/search?q=store'))[0]?.title ?? (await r('GET', '/api/search?q=store')).results?.[0]?.title, 'X-1 From the store');
  } finally { await s2.close(); }
  await assert.rejects(startServer({ root: p.root, port: 0, plugins: [{ id: 'bad', stores: { board: { read() {} } } }] }), /needs create/);
  await assert.rejects(startServer({ root: p.root, port: 0, plugins: [{ id: 'bad', stores: { nope: {} } }] }), /unknown store/);
});

test('a plugin handle answers its API fallback behind the token, and its own GET prefixes', async () => {
  const seen = [];
  const whole = {
    id: 'whole',
    prefixes: ['/whole/'],
    aliases: { '/old': '/new' },
    routes: { 'GET exact': () => ({ exact: true }) },
    handle(req, res, info) {
      seen.push([req.method, info.kind, info.rest]);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${info.kind}:${info.rest}`);
    },
  };
  const s3 = await startServer({ root: p.root, port: 0, plugins: [whole] });
  try {
    const r = (method, url, { token = s3.token, csrf = true } = {}) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: s3.port, method, path: url, headers: { Host: `127.0.0.1:${s3.port}`, ...(token ? { 'X-Flowrail-Token': token } : {}), ...(method === 'POST' && csrf ? { 'X-Flowrail': '1' } : {}) } }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, data: d })); });
      q.on('error', reject); q.end();
    });
    assert.equal((await r('GET', '/api/x/whole/exact')).data, '{"exact":true}');
    assert.equal((await r('GET', '/api/x/whole/api/leads?x=1')).data, 'api:/api/leads');
    assert.equal((await r('POST', '/api/x/whole/api/move')).data, 'api:/api/move');
    assert.equal((await r('GET', '/api/x/whole/api/leads', { token: null })).status, 401, 'the fallback keeps the token check');
    assert.equal((await r('POST', '/api/x/whole/api/move', { csrf: false })).status, 403, 'and the CSRF header');
    assert.equal((await r('GET', '/whole/ui/a.js', { token: null })).data, 'file:/whole/ui/a.js');
    assert.equal((await r('GET', '/ui/app.js', { token: null })).status, 200, 'built-in paths still answer');
    assert.deepEqual((await (async () => JSON.parse((await r('GET', '/api/plugins')).data))())[0].aliases, { '/old': '/new' });
  } finally { await s3.close(); }
  assert.throws(() => validate({ id: 'a', prefixes: ['/api/'], handle() {} }), /prefix/);
  assert.throws(() => validate({ id: 'a', prefixes: ['/a/'] }), /needs handle/);
  assert.throws(() => validate({ id: 'a', aliases: { old: '/new' } }), /alias/);
});
