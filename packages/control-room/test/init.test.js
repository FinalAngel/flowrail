import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { planInit, apply } from '../src/core/init.js';
import { GUARD_REL } from 'flowrail/api';
import { paths } from 'flowrail/api';
import { overview } from '../src/core/overview.js';
import { tmpdir, BIN } from './helpers.js';

const cli = (root, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

function project() {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Notes\n\n- Never push without asking.\n');
  return root;
}

test('init never overwrites flowrail files that exist', () => {
  const root = project();
  fs.mkdirSync(path.join(root, 'flowrail'));
  fs.writeFileSync(path.join(root, 'flowrail', 'board.json'), '{"tasks":[{"id":"T-0042"}]}');
  apply(root, planInit(root, {}).changes);
  assert.equal(fs.readFileSync(path.join(root, 'flowrail', 'board.json'), 'utf8'), '{"tasks":[{"id":"T-0042"}]}');
});

test('the full init adds flowrailOS files and the CLAUDE.md block on top of the guard', () => {
  const root = project();
  apply(root, planInit(root, {}).changes);
  for (const f of ['flowrail/board.json', 'flowrail/WELCOME.md', 'flowrail/memory/INDEX.md', 'flowrail/red-lines.json', `${GUARD_REL}/hook.mjs`]) assert.ok(fs.existsSync(path.join(root, f)), f);
  const cm = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  const block = cm.slice(cm.indexOf('<!-- flowrail:start -->'), cm.indexOf('<!-- flowrail:end -->')).split('\n').slice(1).filter(Boolean);
  assert.equal(block.length, 2, 'two lines');
  assert.match(block[0], /red-lines\.json/);
  assert.doesNotMatch(cm, /npx/, 'no per-session commands: the SessionStart hook injects comments');
  assert.deepEqual(planInit(root, {}).changes, [], 'second run changes nothing');
});

test('a guard-only init writes no CLAUDE.md block', () => {
  const root = project();
  apply(root, planInit(root, { minimal: true }).changes);
  assert.equal(fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8'), '# Notes\n\n- Never push without asking.\n');
});

test('a changed guard file shows as not enforced in the overview and status', () => {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  const p = paths(root);
  const hook = path.join(root, GUARD_REL, 'hook.mjs');
  fs.writeFileSync(hook, 'process.exit(0);\n' + fs.readFileSync(hook, 'utf8'));
  const o = overview(p);
  assert.equal(o.hooks.healthy, false);
  assert.equal(o.hooks.guard.verified, false);
  assert.equal(o.counts.redlinesArmed, 0);
  assert.equal(o.attention[0].kind, 'hooks');
  assert.equal(JSON.parse(cli(root, 'status', '--json').stdout).hooks, false);
  assert.equal(cli(root, 'upgrade', '--yes').status, 0);
  assert.equal(overview(p).hooks.healthy, true);
});

test('init offers the add-context skill and never overwrites one that exists', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { planInit } = await import('../src/core/init.js');
  const { tmpdir } = await import('./helpers.js');
  const fresh = tmpdir();
  const plan = planInit(fresh, {});
  const add = plan.changes.find((c) => c.path === '.claude/skills/add-context/SKILL.md');
  assert.ok(add, 'the skill is in the plan');
  assert.match(add.after, /^---\nname: add-context/);
  const mine = tmpdir();
  fs.mkdirSync(path.join(mine, '.claude', 'skills', 'add-context'), { recursive: true });
  fs.writeFileSync(path.join(mine, '.claude', 'skills', 'add-context', 'SKILL.md'), 'mine');
  assert.ok(!planInit(mine, {}).changes.some((c) => c.path === '.claude/skills/add-context/SKILL.md'));
});
