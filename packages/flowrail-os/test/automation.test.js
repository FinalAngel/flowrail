import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { validate as validateApps, list as listApps, start, stop, log } from '../src/core/apps.js';
import * as routines from '../src/core/routines.js';
import { parseWorkflow, list as listWorkflows } from '../src/core/workflows.js';
import { startServer } from '../src/server.js';
import { workspace } from './helpers.js';

const setConfig = (p, extra) => fs.writeFileSync(p.config, JSON.stringify({ ...JSON.parse(fs.readFileSync(p.config, 'utf8')), ...extra }));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) return false; await new Promise((r) => setTimeout(r, 25)); } return true; };

test('apps: the config is checked before anything runs', () => {
  assert.deepEqual(validateApps(undefined), []);
  assert.deepEqual(validateApps([{ id: 'docs', name: 'Docs', cmd: ['npm', 'run', 'docs'], cwd: 'site', url: 'http://127.0.0.1:3000' }]), []);
  const errs = validateApps([{ id: 'Docs', name: '', cmd: 'npm run docs', cwd: '../up', url: 'file:///etc/passwd' }, { id: 'a', name: 'A', cmd: ['x'] }, { id: 'a', name: 'B', cmd: ['y'] }]);
  for (const re of [/id must be/, /name is required/, /cmd must be an argv array/, /cwd must be a folder inside/, /url must be http/, /duplicate id/]) assert.ok(errs.some((e) => re.test(e)), re);
  assert.match(validateApps({})[0], /array/);
});

test('apps: start runs the argv detached and stop ends its process group', async () => {
  const p = workspace();
  setConfig(p, { apps: [{ id: 'tick', name: 'Tick', cmd: [process.execPath, '-e', "console.log('up'); setInterval(() => {}, 1000)"] }] });
  const s = start(p, 'tick');
  assert.ok(s.pid);
  assert.equal((await listApps(p))[0].running, true);
  await assert.rejects(async () => start(p, 'tick'), /already running/);
  assert.ok(await until(() => log(p, 'tick').includes('up')), 'output goes to .flowrail/apps/tick.log');
  stop(p, 'tick');
  assert.ok(await until(() => !alive(s.pid)), 'the process is gone');
  assert.equal((await listApps(p))[0].running, false);
  assert.throws(() => start(p, 'nope'), /no app nope/);
  assert.throws(() => stop(p, '../x'), /no app/);
});

test('apps: the API starts and stops by id and can never add or change one', async () => {
  const p = workspace();
  setConfig(p, { apps: [{ id: 'tick', name: 'Tick', cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)'] }] });
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
  const evil = { id: 'evil', name: 'Evil', cmd: ['sh', '-c', 'echo pwned'] };
  assert.equal((await call('POST', '/api/apps', { _action: 'save', apps: [evil] })).status, 400);
  await call('POST', '/api/config', { apps: [evil] });
  assert.deepEqual(JSON.parse(fs.readFileSync(p.config, 'utf8')).apps.map((a) => a.id), ['tick'], 'the settings API ignores apps');
  assert.equal((await call('POST', '/api/apps', { _action: 'start', id: 'evil' })).status, 404);
  const started = await call('POST', '/api/apps', { _action: 'start', id: 'tick' });
  assert.equal(started.status, 200);
  const auto = await call('GET', '/api/automation');
  assert.equal(auto.json.apps[0].running, true);
  assert.ok(Array.isArray(auto.json.headless.allowed));
  assert.equal((await call('POST', '/api/apps', { _action: 'stop', id: 'tick' })).status, 200);
  assert.ok(await until(() => !alive(started.json.pid)));
});

test('event routines: validated, never scheduled, and not run from here', async () => {
  const p = workspace();
  const list = [
    { id: 'ci', title: 'CI', on: { event: 'github-actions', repo: 'acme/app', workflow: 'ci.yml' } },
    { id: 'notes', title: 'Notes', on: { event: 'hook' } },
    { id: 'daily', title: 'Daily', schedule: { every: 'day', at: '08:00' }, run: { type: 'command', cmd: ['git', 'status'] } },
  ];
  assert.deepEqual(routines.validate(list), []);
  const bad = routines.validate([{ id: 'x', on: { event: 'github-actions', repo: 'no slash', workflow: 'ci' }, schedule: { every: 'day', at: '08:00' } }, { id: 'y', on: { event: 'push' } }]);
  for (const re of [/owner\/name/, /workflow file name/, /has no schedule/, /on.event must be/]) assert.ok(bad.some((e) => re.test(e)), re);
  fs.writeFileSync(p.routines, JSON.stringify(list));
  assert.deepEqual(routines.commandRoutines(p).map((r) => r.id), ['daily'], 'an event routine is never scheduled');
  const rows = routines.list(p);
  assert.equal(rows.find((r) => r.id === 'ci').scheduleText, 'On GitHub Actions: ci.yml');
  assert.equal(rows.find((r) => r.id === 'ci').next, null);
  await assert.rejects(routines.runNow(p, 'notes'), /not from here/);
});

test('event routines: gh is read through a cache and a failure says GitHub unavailable', async () => {
  const p = workspace();
  fs.writeFileSync(p.routines, JSON.stringify([{ id: 'ci', title: 'CI', on: { event: 'github-actions', repo: 'acme/app', workflow: 'ci.yml' } }]));
  let calls = 0;
  const exec = async (args) => {
    calls++;
    assert.deepEqual(args.slice(0, 6), ['run', 'list', '--repo', 'acme/app', '--workflow', 'ci.yml']);
    return JSON.stringify([{ status: 'completed', conclusion: 'success', createdAt: '2026-01-02T10:00:00Z', displayTitle: 'Fix', headBranch: 'main', url: 'https://github.com/acme/app/actions/runs/1' }, { status: 'completed', conclusion: 'failure', createdAt: '2026-01-01T10:00:00Z', displayTitle: 'Break', headBranch: 'main', url: 'javascript:alert(1)' }]);
  };
  const now = Date.parse('2026-01-02T12:00:00Z');
  const first = await routines.githubRuns(p, { exec, now });
  assert.equal(first.ci.runs[0].conclusion, 'success');
  assert.equal(first.ci.runs[1].url, null, 'only github.com links are kept');
  await routines.githubRuns(p, { exec, now: now + 60000 });
  assert.equal(calls, 1, 'cached for five minutes');
  const failing = await routines.githubRuns(p, { exec: async () => { throw new Error('gh: not logged in'); }, now: now + 6 * 60000 });
  assert.deepEqual(Object.keys(failing.ci), ['error', 'at']);
  assert.equal(failing.ci.error, 'GitHub unavailable');
});

test('workflows: Action and Sub-command groups hold their own steps; workflowsDir picks the folder', () => {
  const wf = parseWorkflow('# Leads\n\nIntro.\n\n## Action: add\n\n### Step 1: Research\nr\n\n### Step 2: SIGN-OFF on the list\ns\n\n## Sub-command: export\n\n## Step 1: Write the CSV\nw\n', 'workflows/leads.md');
  assert.equal(wf.description, 'Intro.');
  assert.deepEqual(wf.steps, []);
  assert.deepEqual(wf.groups.map((g) => [g.kind, g.title, g.steps.map((s) => [s.n, s.gate])]), [['action', 'add', [[1, false], [2, true]]], ['sub-command', 'export', [[1, false]]]]);
  assert.equal(parseWorkflow('## Step 1: MANDATORY check\n').steps[0].gate, true);

  const p = workspace();
  fs.mkdirSync(path.join(p.root, 'playbooks'));
  fs.writeFileSync(path.join(p.root, 'playbooks', 'ship.md'), '# Ship\n\n## Step 1: Go\n');
  fs.writeFileSync(path.join(p.root, 'playbooks', 'README.md'), '# About\n');
  setConfig(p, { workflowsDir: 'playbooks' });
  assert.deepEqual(listWorkflows(p).map((w) => w.file), ['playbooks/ship.md']);
  setConfig(p, { workflowsDir: '../elsewhere' });
  assert.ok(listWorkflows(p).every((w) => w.file.startsWith('flowrail/workflows/')), 'a folder outside the repo falls back to the default');
});
