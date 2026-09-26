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
  assert.deepEqual(r.json, [{ id: 'crm', pages: [{ id: 'crm:leads', title: 'Leads', path: '/leads', group: 'Sales', icon: 'board', module: '/x/crm/leads.js' }] }]);
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

test('a malformed plugin is refused before the server starts', async () => {
  assert.throws(() => validate({ id: 'Bad' }), /id must match/);
  assert.throws(() => validate({ id: 'a', routes: { 'DELETE x': () => {} } }), /route/);
  assert.throws(() => validate({ id: 'a', routes: { 'GET ../x': () => {} } }), /route/);
  assert.throws(() => validate({ id: 'a', ui: 'rel', pages: [] }), /absolute/);
  assert.throws(() => validate({ id: 'a', ui, pages: [{ id: 'x', title: 'X', path: '/x', module: '../x.js' }] }), /module/);
  await assert.rejects(startServer({ root: p.root, port: 0, plugins: [crm, crm] }), /twice/);
});

test('config plugins load from inside the repo only', async () => {
  fs.writeFileSync(path.join(p.root, 'room.mjs'), "export default { id: 'local', routes: { 'GET hi': () => 'hi' } };");
  assert.equal((await fromConfig(p.root, ['room.mjs']))[0].id, 'local');
  await assert.rejects(fromConfig(p.root, ['../x.mjs']), /outside the repo/);
});
