import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { settings, fetchIssues, forSprint, cacheFile, TTL } from '../src/core/github.js';
import { workspace } from './helpers.js';

const raw = [
  { number: 1, title: 'Open one', url: 'https://github.com/o/r/issues/1', state: 'OPEN', labels: [{ name: 'bug' }], assignees: [{ login: 'me' }] },
  { number: 2, title: 'Closed in sprint', url: 'u2', state: 'CLOSED', closedAt: '2026-01-07T10:00:00Z' },
  { number: 3, title: 'Closed before', url: 'u3', state: 'CLOSED', closedAt: '2025-12-20T10:00:00Z' },
];
const config = { github: { repo: 'o/r', assignee: '@me' } };

test('GitHub is off unless the config names a valid repo', () => {
  assert.equal(settings({}), null);
  assert.equal(settings({ github: { repo: 'not a repo' } }), null);
  assert.equal(settings({ github: { repo: 'o/r', assignee: '$(rm -rf ~)' } }), null);
  assert.deepEqual(settings({ github: { repo: 'o/r' } }), { repo: 'o/r', assignee: '@me' });
});

test('fetchIssues asks gh once, read-only, and caches the answer for five minutes', async () => {
  const p = workspace();
  assert.equal(await fetchIssues(p, {}, { run: () => { throw new Error('must not run'); } }), null);
  const calls = [];
  const run = async (args) => { calls.push(args); return JSON.stringify(raw); };
  const now = Date.parse('2026-01-08T12:00:00Z');
  const r = await fetchIssues(p, config, { run, now });
  assert.equal(r.available, true);
  assert.deepEqual(r.issues[0].labels, ['bug']);
  assert.deepEqual(r.issues[0].assignees, ['me']);
  assert.deepEqual(calls[0].slice(0, 2), ['issue', 'list'], 'only ever lists');
  assert.ok(calls[0].includes('--json') && calls[0].includes('o/r'));
  await fetchIssues(p, config, { run, now: now + TTL - 1000 });
  assert.equal(calls.length, 1, 'cached');
  await fetchIssues(p, config, { run, now: now + TTL + 1000 });
  assert.equal(calls.length, 2, 'stale cache refetches');
  await fetchIssues(p, config, { run, now: now + TTL + 2000, force: true });
  assert.equal(calls.length, 3, 'refresh forces a fetch');
});

test('a failing gh says "GitHub unavailable" and is not cached; the demo never runs gh', async () => {
  const p = workspace();
  const r = await fetchIssues(p, config, { run: async () => { throw new Error('gh: not found'); } });
  assert.deepEqual(r, { available: false, repo: 'o/r', issues: [], error: 'GitHub unavailable' });
  assert.equal(fs.existsSync(cacheFile(p)), false);
  const demo = await fetchIssues(p, { ...config, demo: true }, { run: async () => { throw new Error('must not run'); } });
  assert.equal(demo.available, false);
  fs.writeFileSync(cacheFile(p), JSON.stringify({ repo: 'o/r', at: '2020-01-01T00:00:00Z', issues: raw }));
  const seeded = await fetchIssues(p, { ...config, demo: true }, { run: async () => { throw new Error('must not run'); } });
  assert.equal(seeded.issues.length, 3, 'the demo reads its seeded cache however old');
});

test('a sprint shows open issues and those closed inside it', () => {
  const got = forSprint(raw, { start: '2026-01-05', end: '2026-01-18' }).map((i) => i.number);
  assert.deepEqual(got, [1, 2]);
  assert.deepEqual(forSprint(raw, null), []);
});

test('assignee "*" lists every assigned issue, whoever has it', async () => {
  const { settings, fetchIssues } = await import('../src/core/github.js');
  assert.deepEqual(settings({ github: { repo: 'o/r', assignee: '*' } }), { repo: 'o/r', assignee: '*' });
  const { workspace } = await import('./helpers.js');
  const p = workspace();
  let args;
  const run = async (a) => { args = a; return JSON.stringify([{ number: 1, title: 'a', assignees: [{ login: 'x' }] }, { number: 2, title: 'b', assignees: [] }]); };
  const r = await fetchIssues(p, { github: { repo: 'o/r', assignee: '*' } }, { run, force: true });
  assert.ok(!args.includes('--assignee'));
  assert.deepEqual(r.issues.map((i) => i.number), [1]);
});
