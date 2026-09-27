import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { workspace, BIN } from './helpers.js';
import { sinceFor } from '../src/core/today.js';

const cli = (root, args, input = '') => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', input, env: { ...process.env, NO_COLOR: '1', CLAUDECODE: '' } });

test('flowrail task files into the current sprint, so flowrail tasks shows it', () => {
  const p = workspace();
  const t = JSON.parse(cli(p.root, ['task', 'Fix the login bug', '--json']).stdout);
  assert.ok(t.sprint, 'not the backlog');
  assert.match(cli(p.root, ['tasks']).stdout, /Fix the login bug/);
  const b = JSON.parse(cli(p.root, ['task', 'Someday', '--sprint', 'backlog', '--json']).stdout);
  assert.equal(b.sprint, '');
  assert.doesNotMatch(cli(p.root, ['tasks']).stdout, /Someday/);
});

test('flowrail today shows moves made by the agent', () => {
  const p = workspace();
  cli(p.root, ['task', 'update', 'T-0001', '--status', 'In Progress', '--agent']);
  const t = JSON.parse(cli(p.root, ['today', '--json']).stdout);
  const moved = t.items.find((i) => i.title === 'Moved T-0001 to In Progress');
  assert.equal(moved.by, 'agent');
  assert.equal(t.counts.tasksMoved, 1);
  assert.match(cli(p.root, ['today']).stdout, /Moved T-0001 to In Progress \(agent\)/);
});

test('today starts at local midnight, or 24 hours back before 06:00', () => {
  const noon = new Date(2026, 8, 26, 12, 0);
  assert.equal(sinceFor(noon).getTime(), new Date(2026, 8, 26).getTime());
  const late = new Date(2026, 8, 26, 2, 30);
  assert.equal(sinceFor(late).getTime(), late.getTime() - 86400000);
});

test('flowrail routines install shows each command and never schedules without a yes', () => {
  const p = workspace();
  fs.writeFileSync(p.routines, JSON.stringify([{ id: 'sweep', title: 'Sweep', schedule: { every: 'day', at: '07:00' }, run: { type: 'command', cmd: ['sh', '-c', 'echo hi'] } }]));
  const r = cli(p.root, ['routines', 'install']);
  assert.match(r.stdout, /runs "sh" "-c" "echo hi"/);
  assert.match(r.stdout, /nothing was scheduled/);
  assert.equal(r.status, 2);
});

test('redlines test is a dry run: it never logs a hold', () => {
  const p = workspace({ minimal: true });
  assert.match(cli(p.root, ['redlines', 'test', 'git push --force']).stdout, /held \(block\).*force push/);
  assert.ok(!fs.existsSync(p.redlinesLog));
  assert.match(cli(p.root, ['redlines']).stdout, /Asks before any git push/);
});

test('a fresh workspace has an empty Today: init\'s starter tasks, memory and report are seed', () => {
  const p = workspace();
  const t = JSON.parse(cli(p.root, ['today', '--json']).stdout);
  assert.deepEqual(t.items.filter((i) => i.kind !== 'commit' && i.kind !== 'redlines-changed'), []);
  cli(p.root, ['task', 'A real one']);
  const after = JSON.parse(cli(p.root, ['today', '--json']).stdout);
  assert.deepEqual(after.items.filter((i) => i.kind === 'task').map((i) => i.title), ['Filed T-0005 A real one']);
});

test('today takes a since for "While you were away"', async () => {
  const { today, parseSince } = await import('../src/core/today.js');
  const p = workspace();
  cli(p.root, ['task', 'update', 'T-0001', '--status', 'Done']);
  const now = new Date();
  assert.equal(today(p, now, { since: parseSince(new Date(now.getTime() + 60000).toISOString(), now) }).items.length, 0);
  assert.ok(today(p, now, { since: parseSince(new Date(now.getTime() - 60000).toISOString(), now) }).items.some((i) => /Moved T-0001 to Done/.test(i.title)));
  assert.equal(parseSince('not a date', now), null);
  assert.equal(parseSince('2001-01-01T00:00:00Z', now).getTime(), now.getTime() - 30 * 86400000);
});

test('remember defaults to --type project', () => {
  const p = workspace();
  const m = JSON.parse(cli(p.root, ['remember', 'We use pnpm, not npm', '--json']).stdout);
  assert.equal(m.type, 'project');
  assert.match(cli(p.root, ['recall', 'which package manager']).stdout, /We use pnpm, not npm/);
});

test('a terminal files as a human even with CLAUDECODE set; CLAUDECODE without a TTY is the agent', async () => {
  const { atTerminal, byAgent } = await import('../src/cli/work.js');
  const tty = { isTTY: true };
  const io = (env, stdin = tty) => ({ env, stdin, stdout: tty });
  assert.equal(atTerminal({}, io({})), true);
  assert.equal(atTerminal({}, io({ CLAUDECODE: '1' })), true);
  assert.equal(byAgent({}, io({ CLAUDECODE: '1' })), false);
  assert.equal(byAgent({}, io({ CLAUDECODE: '1' }, {})), true);
  assert.equal(byAgent({}, io({}, {})), false, 'a pipe outside Claude Code is not the agent');
  assert.equal(byAgent({ agent: true }, io({})), true);
  assert.equal(atTerminal({ agent: true }, io({})), false);
});
