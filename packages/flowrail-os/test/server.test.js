import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { startServer, ARTIFACT_CSP } from '../src/server.js';
import { workspace } from './helpers.js';

const p = workspace();
fs.writeFileSync(path.join(p.root, '.env'), 'TOKEN=1');
fs.symlinkSync('.env', path.join(p.root, 'envlink.md'));
fs.writeFileSync(p.routines, JSON.stringify([{ id: 'branches', title: 'Branches', schedule: { every: 'day', at: '07:00' }, run: { type: 'command', cmd: ['git', 'branch'] }, enabled: false }]));
const s = await startServer({ root: p.root, port: 0 });
after(() => s.close());

function req(method, url, { headers = {}, body, token = s.token } = {}) {
  return new Promise((resolve, reject) => {
    const h = { Host: `127.0.0.1:${s.port}`, ...(token ? { 'X-Flowrail-Token': token } : {}), ...(method === 'POST' ? { 'X-Flowrail': '1' } : {}), ...headers };
    for (const k of Object.keys(h)) if (h[k] === undefined) delete h[k];
    const r = http.request({ host: '127.0.0.1', port: s.port, method, path: url, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, data, json });
      });
    });
    r.on('error', reject);
    if (body !== undefined) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

test('the page carries the token; the API refuses requests without it', async () => {
  const page = await req('GET', '/', { token: null });
  assert.equal(page.status, 200);
  const meta = /<meta name="flowrail-token" content="([0-9a-f]{64})">/.exec(page.data);
  assert.ok(meta, 'token meta tag in index.html');
  assert.equal(meta[1], s.token);
  for (const [method, url] of [['GET', '/api/overview'], ['GET', '/api/redlines'], ['GET', '/api/docs/file?path=README.md'], ['GET', '/api/runs/x'], ['POST', '/api/redlines'], ['POST', '/api/routines']]) {
    const none = await req(method, url, { token: null, body: method === 'POST' ? { _action: 'save', lines: [] } : undefined });
    assert.equal(none.status, 401, `${method} ${url}`);
    assert.deepEqual(none.json, { error: 'token' });
    assert.equal((await req(method, url, { token: 'f'.repeat(64), body: method === 'POST' ? {} : undefined })).status, 401, `${method} ${url} wrong token`);
  }
  assert.equal(JSON.parse(fs.readFileSync(p.redlines, 'utf8')).length > 0, true, 'the unauthenticated save changed nothing');
});

test('/api/events takes the token as a query parameter', async () => {
  const bad = await req('GET', '/api/events?token=nope', { token: null });
  assert.equal(bad.status, 401);
  await new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port: s.port, path: `/api/events?token=${s.token}`, headers: { Host: `127.0.0.1:${s.port}` } }, (res) => {
      assert.equal(res.statusCode, 200);
      assert.match(res.headers['content-type'], /event-stream/);
      res.destroy();
      resolve();
    });
    r.on('error', (e) => (e.code === 'ECONNRESET' ? resolve() : reject(e)));
  });
});

test('GET /api/overview returns the dashboard shape', async () => {
  const r = await req('GET', '/api/overview');
  assert.equal(r.status, 200);
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.equal(r.headers['cache-control'], 'no-store');
  for (const k of ['workspace', 'setup', 'attention', 'counts', 'recent', 'git', 'hooks']) assert.ok(k in r.json, k);
  assert.deepEqual(Object.keys(r.json.hooks).sort(), ['command', 'guard', 'healthy', 'installed', 'where']);
  assert.equal(r.json.hooks.healthy, true);
  assert.equal(r.json.hooks.guard.verified, true);
  assert.deepEqual(r.json.hooks.guard.changed, []);
  assert.equal(r.json.setup.steps.length, 5);
  assert.equal(r.json.counts.tasksOpen, 4);
});

test('writes need the X-Flowrail header too', async () => {
  const body = { _action: 'create', title: 'x' };
  assert.equal((await req('POST', '/api/board', { body, headers: { 'X-Flowrail': undefined } })).status, 403);
  const ok = await req('POST', '/api/board', { body, headers: { 'Content-Type': 'application/json' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, 'T-0005');
});

test('foreign Host and Origin are refused', async () => {
  assert.equal((await req('GET', '/api/overview', { headers: { Host: 'evil.example' } })).status, 421);
  assert.equal((await req('GET', '/api/overview', { headers: { Host: `attacker.example:${s.port}` } })).status, 421);
  assert.equal((await req('GET', '/', { headers: { Host: `attacker.example:${s.port}` } })).status, 421, 'the token page is not served to a rebinding host');
  assert.equal((await req('GET', '/api/overview', { headers: { Host: `localhost:${s.port}` } })).status, 200);
  assert.equal((await req('POST', '/api/board', { headers: { Origin: 'http://evil.example' }, body: {} })).status, 403);
});

test('docs go through the path gate, symlinks included', async () => {
  assert.equal((await req('GET', '/api/docs/file?path=.env')).status, 403);
  const link = await req('GET', '/api/docs/file?path=envlink.md');
  assert.equal(link.status, 403, 'a symlink to .env is judged by its target');
  assert.ok(!link.data.includes('TOKEN=1'));
  assert.equal((await req('POST', '/api/docs/file', { body: { path: 'envlink.md', text: 'x' } })).status, 403);
  assert.equal(fs.readFileSync(path.join(p.root, '.env'), 'utf8'), 'TOKEN=1');
  assert.equal((await req('GET', '/api/docs/file?path=..%2F..%2Fetc%2Fpasswd')).status, 400);
  const ok = await req('GET', '/api/docs/file?path=flowrail%2FWELCOME.md');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.kind, 'markdown');
  const stale = await req('POST', '/api/docs/file', { body: { path: 'flowrail/WELCOME.md', text: 'x', mtime: 1 } });
  assert.equal(stale.status, 409);
  const tree = await req('GET', '/api/docs/tree');
  assert.ok(!JSON.stringify(tree.json).includes('.env'));
});

test('artifacts are sandboxed with no network access', async () => {
  const r = await req('GET', '/artifacts/welcome.html', { token: null });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-security-policy'], ARTIFACT_CSP);
  for (const d of ['sandbox allow-scripts;', "default-src 'none'", "connect-src 'none'", "form-action 'none'", 'img-src data:']) assert.ok(ARTIFACT_CSP.includes(d), d);
  assert.ok(!/allow-popups|allow-same-origin|allow-top-navigation/.test(ARTIFACT_CSP), 'no popups, no shared origin, no top navigation');
  assert.equal((await req('GET', '/artifacts/..%2Fconfig.json')).status, 404);
});

test('command routines cannot be created or changed over HTTP', async () => {
  const evil = [{ id: 'pwn', title: 'x', schedule: { every: 'day', at: '07:00' }, run: { type: 'command', cmd: ['sh', '-c', 'echo PWNED > pwned.txt'] } }];
  const add = await req('POST', '/api/routines', { body: { _action: 'save', routines: evil } });
  assert.equal(add.status, 403);
  const existing = JSON.parse(fs.readFileSync(p.routines, 'utf8'));
  const change = await req('POST', '/api/routines', { body: { _action: 'save', routines: [{ ...existing[0], run: { type: 'command', cmd: ['sh', '-c', 'git push'] } }] } });
  assert.equal(change.status, 403);
  assert.equal((await req('POST', '/api/routines', { body: { _action: 'run', id: 'pwn' } })).status, 404);
  assert.ok(!fs.existsSync(path.join(p.root, 'pwned.txt')));
  // Keeping or rescheduling a command routine that is already in the file is fine; so are claude routines.
  const keep = await req('POST', '/api/routines', { body: { _action: 'save', routines: [{ ...existing[0], schedule: { every: 'monday', at: '08:00' } }, { id: 'brief', title: 'Brief', schedule: { every: 'day', at: '08:00' }, run: { type: 'claude', prompt: 'Summarize' } }] } });
  assert.equal(keep.status, 200, keep.data);
  fs.writeFileSync(p.routines, JSON.stringify([{ ...existing[0], enabled: true }]));
  const install = await req('POST', '/api/routines', { body: { _action: 'install' } });
  assert.equal(install.status, 403);
  assert.match(install.json.error, /from the terminal/);
});

test('routines save merges by id; only an explicit delete removes one', async () => {
  const seeded = { id: 'seeded', title: 'Seeded', schedule: { every: 'day', at: '07:00' }, run: { type: 'claude', prompt: 'x' } };
  const other = { id: 'other', title: 'Other', schedule: { every: 'day', at: '09:00' }, run: { type: 'claude', prompt: 'y' } };
  fs.writeFileSync(p.routines, JSON.stringify([seeded, other]));
  const save = await req('POST', '/api/routines', { body: { _action: 'save', routines: [{ ...other, title: 'Renamed' }] } });
  assert.equal(save.status, 200, save.data);
  const ids = () => JSON.parse(fs.readFileSync(p.routines, 'utf8')).map((r) => `${r.id}:${r.title}`);
  assert.deepEqual(ids(), ['seeded:Seeded', 'other:Renamed']);
  assert.equal((await req('POST', '/api/routines', { body: { _action: 'save', routines: [] } })).status, 200);
  assert.deepEqual(ids(), ['seeded:Seeded', 'other:Renamed'], 'an empty save drops nothing');
  assert.equal((await req('POST', '/api/routines', { body: { _action: 'delete', id: 'seeded' } })).status, 200);
  assert.deepEqual(ids(), ['other:Renamed']);
  assert.equal((await req('POST', '/api/routines', { body: { _action: 'delete', id: 'nope' } })).status, 404);
});

test('the API adds and tightens red lines, never weakens them; each save is logged', async () => {
  const before = JSON.parse(fs.readFileSync(p.redlines, 'utf8'));
  const weaken = [
    ['empty', []],
    ['remove one', before.slice(1)],
    ['lower a severity', before.map((l) => (l.severity === 'block' ? { ...l, severity: 'warn' } : l))],
    ['swap a hook', before.map((l) => (l.id === 'no-push-without-asking' ? { ...l, hook: { tool: 'Bash', match: '^nothing$' } } : l))],
  ];
  for (const [label, lines] of weaken) {
    const r = await req('POST', '/api/redlines', { body: { _action: 'save', lines } });
    assert.equal(r.status, 409, label);
    assert.match(r.json.error, /Edit flowrail\/red-lines\.json yourself to weaken a rule/, label);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(p.redlines, 'utf8')), before, 'nothing was written');
  // What the dashboard sends back (describe() output, floor line included) saves cleanly.
  const shown = (await req('GET', '/api/redlines')).json.lines;
  const extra = { id: 'no-drop-table', title: 'Never drop tables', severity: 'ask', hook: { tool: 'Bash', match: 'drop table', flags: 'i', raw: true } };
  const r = await req('POST', '/api/redlines', { body: { _action: 'save', lines: [...shown.map((l) => (l.id === 'no-push-without-asking' ? { ...l, severity: 'block' } : l)), extra] } });
  assert.equal(r.status, 200, r.data);
  assert.deepEqual(r.json.change.added, ['no-drop-table']);
  assert.deepEqual(r.json.change.changed, ['no-push-without-asking']);
  const saved = JSON.parse(fs.readFileSync(p.redlines, 'utf8'));
  assert.ok(!saved.some((l) => 'floor' in l || 'summary' in l), 'derived fields are not written');
  const o = (await req('GET', '/api/overview')).json;
  assert.ok(o.attention.find((a) => a.kind === 'redlines-changed'));
  const t = (await req('GET', '/api/today')).json;
  assert.ok(t.items.some((i) => i.kind === 'redlines-changed'));
  fs.writeFileSync(p.redlines, JSON.stringify(before, null, 2));
});

test('POST /api/run is gone: nothing over HTTP starts a headless Claude with a free-form prompt', async () => {
  const r = await req('POST', '/api/run', { body: { prompt: 'git push' } });
  assert.equal(r.status, 404);
});

test('hard links are never served', async () => {
  const outside = path.join(path.dirname(p.root), `outside-${process.pid}.txt`);
  fs.writeFileSync(outside, 'SECRET OUTSIDE');
  fs.linkSync(outside, path.join(p.root, 'hard.md'));
  const r = await req('GET', '/api/docs/file?path=hard.md');
  assert.equal(r.status, 403);
  assert.ok(!r.data.includes('SECRET OUTSIDE'));
  fs.linkSync(path.join(p.root, 'hard.md'), path.join(p.artifacts, 'hard.html'));
  assert.equal((await req('GET', '/artifacts/hard.html', { token: null })).status, 403);
  for (const f of [path.join(p.root, 'hard.md'), path.join(p.artifacts, 'hard.html'), outside]) fs.rmSync(f);
});

test('GET /api/redlines: summaries, builtins, hook state, probe-free stats', async () => {
  const r = (await req('GET', '/api/redlines')).json;
  const push = r.lines.find((l) => l.id === 'no-push-without-asking');
  assert.equal(push.builtin, 'git-push');
  assert.match(push.summary, /^Asks before any git push/);
  assert.equal(r.hooksInstalled, true);
  assert.deepEqual(Object.keys(r.hooksState).sort(), ['command', 'guard', 'healthy', 'installed', 'where']);
  const floor = r.lines.find((l) => l.id === 'protect-flowrail');
  assert.equal(floor.floor, true);
  assert.equal(floor.state, 'armed');
  for (const id of ['ask-before-mcp-actions']) assert.ok(r.lines.some((l) => l.id === id), id);
  assert.equal(typeof r.stats.held7d, 'number');
  assert.equal(typeof r.stats.probes7d, 'number');
});

test('GET /api/today has the contract shape', async () => {
  await req('POST', '/api/board', { body: { _action: 'update', id: 'T-0001', status: 'In Progress' } });
  const t = (await req('GET', '/api/today')).json;
  assert.ok(!Number.isNaN(Date.parse(t.since)));
  assert.deepEqual(Object.keys(t.counts).sort(), ['artifacts', 'commentsResolved', 'commits', 'held', 'memories', 'routines', 'tasksCreated', 'tasksMoved']);
  const moved = t.items.find((i) => i.kind === 'task' && /Moved T-0001 to In Progress/.test(i.title));
  assert.ok(moved);
  assert.equal(moved.by, 'human');
  assert.equal(moved.href, '#/board?task=T-0001');
  assert.ok(t.items.length <= 50);
  for (let i = 1; i < t.items.length; i++) assert.ok(t.items[i - 1].at >= t.items[i].at, 'newest first');
});

test('red-line tester and bad JSON bodies', async () => {
  const t = await req('POST', '/api/redlines', { body: { _action: 'test', tool: 'Bash', subject: 'sudo git push' } });
  assert.equal(t.json.decision, 'ask');
  assert.equal((await req('POST', '/api/redlines', { body: '{not json' })).status, 400);
  assert.equal((await req('GET', '/api/nope')).status, 404);
});

test('every GET route answers', async () => {
  for (const url of ['/api/board', '/api/docs/tree', '/api/comments', '/api/memory', '/api/recall?q=flowrail', '/api/redlines', '/api/graph', '/api/workflows', '/api/routines', '/api/team', '/api/artifacts', '/api/links', '/api/runs', '/api/search?q=welcome', '/api/doctor', '/api/config', '/api/today', '/']) {
    assert.equal((await req('GET', url)).status, 200, url);
  }
});

test('GET /api/audit and GET /api/today?since', async () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(p.root, '.claude-empty-'));
  try {
    const a = (await req('GET', '/api/audit?days=7')).json;
    assert.equal(a.days, 7);
    assert.deepEqual([a.calls, a.sessions, a.held, a.asked, a.byLine], [0, 0, [], [], {}]);
    assert.match(a.note, /No Claude Code transcripts/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
  const future = new Date(Date.now() + 3600000).toISOString();
  const t = (await req('GET', `/api/today?since=${encodeURIComponent(future)}`)).json;
  assert.deepEqual(t.items, []);
  assert.ok(Date.parse(t.since) <= Date.now());
});
