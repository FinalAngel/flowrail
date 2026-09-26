import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { workspace } from './helpers.js';

const p = workspace();
const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true }); fs.writeFileSync(path.join(p.root, rel), text); };
w('docs/a.md', '# A');
w('notes/private-ish.md', '# Not shown');
w('reports/weekly.html', '<title>Weekly</title>');
w('reports/weekly.json', JSON.stringify({ title: 'The weekly report', summary: 'numbers' }));
w('lists/links.json', JSON.stringify({ categories: [{ name: 'Tools', links: [{ title: 'Site', url: 'https://example.com' }, { title: 'Bad', url: 'javascript:alert(1)' }] }] }));
const config = JSON.parse(fs.readFileSync(p.config, 'utf8'));
fs.writeFileSync(p.config, JSON.stringify({ ...config, docsRoots: ['docs', 'README.md'], artifactsDir: 'reports', linksFile: 'lists/links.json' }));

const facts = [{ name: 'use-pnpm', type: 'feedback', description: 'Use pnpm', body: 'Use pnpm.', path: null }];
const memory = { list: () => facts, recall: (q) => facts.filter((f) => f.body.toLowerCase().includes(q)).map((f) => ({ ...f, score: 1, snippet: f.body })), store: (m) => { facts.push({ ...m, path: null }); return { name: m.name }; } };
const s = await startServer({ root: p.root, port: 0, plugins: [{ id: 'mem', stores: { memory } }] });
after(() => s.close());

const req = (method, url, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers: { Host: `127.0.0.1:${s.port}`, 'X-Flowrail-Token': s.token, ...(method === 'POST' ? { 'X-Flowrail': '1' } : {}) } }, (res) => {
    let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d || 'null') }));
  });
  r.on('error', reject); if (body) r.write(JSON.stringify(body)); r.end();
});

test('docsRoots limits what Docs lists, reads and writes', async () => {
  const flat = JSON.stringify((await req('GET', '/api/docs/tree')).json);
  assert.match(flat, /docs\/a\.md/);
  assert.doesNotMatch(flat, /notes\/private-ish/);
  assert.equal((await req('GET', '/api/docs/file?path=notes/private-ish.md')).status, 403);
  assert.equal((await req('GET', '/api/docs/file?path=docs/a.md')).status, 200);
  assert.equal((await req('POST', '/api/docs/file', { _action: 'create', path: 'notes/new.md', text: 'x' })).status, 403);
});

test('artifacts and links come from the configured places', async () => {
  const arts = (await req('GET', '/api/artifacts')).json;
  assert.equal(arts[0].title, 'The weekly report');
  const links = (await req('GET', '/api/links')).json;
  assert.deepEqual(links.map((c) => [c.category, c.items.map((i) => i.title)]), [['Tools', ['Site']]]);
});

test('a memory store backs the Memory page and recall', async () => {
  assert.equal((await req('GET', '/api/memory')).json.items[0].name, 'use-pnpm');
  assert.equal((await req('GET', '/api/recall?q=pnpm')).json.hits[0].name, 'use-pnpm');
  await req('POST', '/api/memory', { _action: 'store', name: 'new-fact', body: 'A new fact' });
  assert.equal(facts.at(-1).name, 'new-fact');
  assert.equal((await req('POST', '/api/memory', { _action: 'trash', name: 'use-pnpm' })).status, 405);
});
