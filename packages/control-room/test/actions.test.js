import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { validate, argv } from '../src/core/actions.js';
import { people } from '../src/core/team.js';
import { startServer } from '../src/server.js';
import { workspace } from './helpers.js';

const setConfig = (p, extra) => fs.writeFileSync(p.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(p.config, 'utf8')), ...extra }));
const meeting = {
  id: 'meeting', title: 'Record a meeting', cmd: ['rec', '--url', '{url}', '--title', '{title}', '--kind', '{kind}'],
  inputs: [{ name: 'url', type: 'url', pattern: '^https://', required: true }, { name: 'title', max: 40 }, { name: 'kind', type: 'select', options: ['sales', '--general'] }],
};

test('actions: the config is checked before anything runs', () => {
  assert.deepEqual(validate(undefined), []);
  assert.deepEqual(validate([meeting]), []);
  const errs = validate([
    { id: 'A', title: 'x', cmd: ['y'] },
    { id: 'part', title: 'Part', cmd: ['rec', '--title={title}'], inputs: [{ name: 'title' }] },
    { id: 'prog', title: 'Prog', cmd: ['{bin}'], inputs: [{ name: 'bin' }] },
    { id: 'ghost', title: 'Ghost', cmd: ['rec', '{nope}'] },
    { id: 'sel', title: 'Sel', cmd: ['rec', '{k}'], inputs: [{ name: 'k', type: 'select' }] },
  ]);
  for (const re of [/id must be/, /fills a whole argument/, /program itself/, /\{nope\}, which is not an input/, /select needs options/]) assert.ok(errs.some((e) => re.test(e)), re);
});

test('actions: every value is one whole argv element, checked first', () => {
  const run = (inputs) => argv(meeting, inputs);
  assert.deepEqual(run({ url: 'https://meet.example/abc', title: 'Weekly', kind: 'sales' }), ['rec', '--url', 'https://meet.example/abc', '--title', 'Weekly', '--kind', 'sales']);
  // Shell syntax is just text: no shell ever sees it, and it stays in its own element.
  for (const t of ['; rm -rf ~', '$(whoami)', '`id` && echo x', 'a b c']) assert.equal(run({ url: 'https://m.example', title: t })[4], t);
  assert.equal(run({ url: 'https://m.example', kind: '--general' })[6], '--general', 'config-defined options are trusted');
  assert.equal(run({ url: 'https://m.example' })[4], '', 'an empty optional input is an empty argument');
  for (const [inputs, re] of [
    [{}, /url is required/],
    [{ url: 'http://m.example' }, /does not match/],
    [{ url: 'javascript:alert(1)' }, /http or https|does not match/],
    [{ url: 'https://m.example', title: 'a\nrm -rf ~' }, /one line/],
    [{ url: 'https://m.example', title: '-rf' }, /cannot start with "-"/],
    [{ url: 'https://m.example', title: 'x'.repeat(41) }, /longer than 40/],
    [{ url: 'https://m.example', kind: 'other' }, /must be one of/],
    [{ url: 'https://m.example', extra: '1' }, /unknown input extra/],
  ]) assert.throws(() => run(inputs), re, JSON.stringify(inputs));
});

test('actions: run by id through the API; config-only; recorded like every run', async () => {
  const p = workspace();
  setConfig(p, { actions: [{ id: 'echo', title: 'Echo', cmd: [process.execPath, '-e', 'for (const a of process.argv.slice(1)) console.log(a)', '{title}'], inputs: [{ name: 'title', required: true }] }] });
  const s = await startServer({ root: p.root, port: 0 });
  after(() => s.close());
  const call = (method, url, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers: { Host: `127.0.0.1:${s.port}`, 'X-Flowrail-Token': s.token, ...(method === 'POST' ? { 'X-Flowrail': '1', 'content-type': 'application/json' } : {}) } }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: d ? JSON.parse(d) : null }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
  await call('POST', '/api/config', { actions: [{ id: 'evil', title: 'Evil', cmd: ['sh', '-c', 'echo pwned'] }] });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.config, 'utf8')).actions.map((a) => a.id), ['echo'], 'the settings API ignores actions');
  assert.equal((await call('POST', '/api/actions', { id: 'evil', inputs: {} })).status, 404);
  assert.equal((await call('POST', '/api/actions', { id: 'echo', inputs: {} })).status, 400);
  const started = await call('POST', '/api/actions', { id: 'echo', inputs: { title: '; rm -rf ~' } });
  assert.equal(started.status, 200);
  let run;
  for (let i = 0; i < 100; i++) { run = (await call('GET', `/api/runs/${started.json.id}`)).json; if (run.status !== 'running') break; await new Promise((r) => setTimeout(r, 30)); }
  assert.equal(run.status, 'ok');
  assert.equal(run.title, 'Echo');
  assert.equal(run.log.trim(), '; rm -rf ~', 'the value arrived as one argument, unexpanded');
  assert.equal((await call('GET', '/api/automation')).json.actions[0].id, 'echo');
});

test('people: one profile file per person, from the configured folder', () => {
  const p = workspace();
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(p.root, rel)), { recursive: true }); fs.writeFileSync(path.join(p.root, rel), text); };
  w('flowrail/people/ana.md', '---\nname: Ana Ruiz\nrole: Design lead\nemail: ana@example.com\nlinks: [https://ana.example, javascript:alert(1)]\n---\n# Ana\n\nOwns the design system.\n');
  w('flowrail/people/README.md', '# People');
  assert.deepEqual(people(p), [{ name: 'Ana Ruiz', role: 'Design lead', email: 'ana@example.com', links: ['https://ana.example'], bio: 'Owns the design system.', path: 'flowrail/people/ana.md' }]);
  w('team/bo.md', '---\nname: Bo\nemail: not-an-email\n---\n');
  setConfig(p, { people: { dir: 'team' } });
  assert.deepEqual(people(p).map((m) => [m.name, m.email, m.path]), [['Bo', '', 'team/bo.md']]);
  setConfig(p, { people: { dir: '../outside' } });
  assert.equal(people(p)[0].path, 'flowrail/people/ana.md', 'a folder outside the repo falls back to the default');
});
