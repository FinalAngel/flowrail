import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { build, areasOf, RING } from '../src/core/graph.js';
import { workspace } from './helpers.js';
import { loadConfig } from 'flowrail/api';

const write = (root, rel, text = '# x\n') => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('areas come from a CLAUDE.md table; the most specific mention wins', () => {
  const p = workspace();
  write(p.root, 'CLAUDE.md', '# Notes\n\n| Area | Router |\n|---|---|\n| Sales | [SALES.md](SALES.md) |\n| Ops | [docs/ops.md](docs/ops.md) |\n');
  write(p.root, 'SALES.md', 'Leads live in `sales/`, the playbook in [the playbook](sales/playbook/intro.md).\n');
  write(p.root, 'docs/ops.md', 'Runbooks: `sales/playbook/`.\n');
  write(p.root, 'sales/leads.md');
  write(p.root, 'sales/playbook/intro.md');
  write(p.root, 'sales/playbook/other.md');
  write(p.root, 'misc/notes.md');
  const { areas, areaOf } = areasOf(p);
  assert.deepEqual(areas.map((a) => a.name), ['Sales', 'Ops']);
  assert.equal(areaOf('SALES.md'), 0, 'a router is in its own area');
  assert.equal(areaOf('sales/leads.md'), 0);
  assert.equal(areaOf('sales/playbook/intro.md'), 0, 'a file named exactly beats a folder above it');
  assert.equal(areaOf('sales/playbook/other.md'), 1, 'the deeper folder wins');
  assert.equal(areaOf('misc/notes.md'), null);
  const g = build(p);
  assert.deepEqual(g.areas.map((a) => a.name), ['Sales', 'Ops']);
  assert.equal(g.nodes.find((n) => n.path === 'sales/leads.md').area, 0);
  assert.equal(g.nodes.find((n) => n.kind === 'folder' && n.path === 'sales').area, 0);
  assert.equal(g.nodes.find((n) => n.kind === 'hub').path, 'CLAUDE.md');
});

test('config areas win over the CLAUDE.md table; paths outside the repo are ignored', () => {
  const p = workspace();
  write(p.root, 'CLAUDE.md', '| Sales | [SALES.md](SALES.md) |\n');
  fs.writeFileSync(p.config, JSON.stringify({ ...loadConfig(p), areas: [{ name: 'Docs', router: 'docs/index.md' }, { name: 'Bad', router: '../x.md' }] }));
  write(p.root, 'docs/index.md', 'All of `docs/`.\n');
  write(p.root, 'docs/a.md');
  const { areas, areaOf } = areasOf(p);
  assert.deepEqual(areas, [{ name: 'Docs', router: 'docs/index.md' }]);
  assert.equal(areaOf('docs/a.md'), 0);
});

test('every node carries its ring; commands are skills; artifacts are on the map', () => {
  const p = workspace();
  write(p.root, '.claude/commands/standup.md');
  write(p.root, '.claude/skills/triage/SKILL.md');
  write(p.root, '.claude/agents/reviewer.md');
  fs.writeFileSync(path.join(p.artifacts, 'digest.html'), '<title>Weekly digest</title>');
  const g = build(p);
  for (const n of g.nodes) assert.equal(n.ring, RING[n.kind] || 'band', n.id);
  const cmd = g.nodes.find((n) => n.id === 'command:standup');
  assert.equal(cmd.kind, 'skill');
  assert.equal(cmd.label, '/standup');
  assert.equal(g.nodes.find((n) => n.id === 'agent:reviewer').ring, 'skill');
  const art = g.nodes.find((n) => n.kind === 'artifact');
  assert.equal(art.label, 'Weekly digest');
  assert.equal(art.ring, 'artifact');
  assert.equal(art.href, '/artifacts/digest.html');
  assert.deepEqual(g.areas, []);
});

test('the map stops at 1500 nodes and says so', () => {
  const p = workspace();
  for (let i = 0; i < 1600; i++) write(p.root, `notes/n${i}.md`);
  const g = build(p);
  assert.ok(g.nodes.length <= 1500);
  assert.equal(g.truncated, true);
});

test('at the node cap, documents give way: routines, artifacts and skills stay on the map', () => {
  const p = workspace();
  for (let i = 0; i < 1600; i++) write(p.root, `notes/n${i}.md`);
  write(p.root, '.claude/skills/review/SKILL.md', '---\nname: review\n---\n');
  fs.mkdirSync(path.join(p.root, 'reports'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'reports', 'weekly.html'), '<title>Weekly</title>');
  const pp = { ...p, artifacts: path.join(p.root, 'reports') };
  const g = build(pp);
  assert.equal(g.truncated, true);
  assert.ok(g.nodes.some((n) => n.kind === 'skill'), 'the skill survives the cap');
  const art = g.nodes.find((n) => n.kind === 'artifact');
  assert.ok(art, 'the artifact survives the cap');
  assert.equal(art.path, 'reports/weekly.html', 'the artifact path follows artifactsDir');
  assert.ok(g.nodes.some((n) => n.kind === 'redline'), 'red lines survive the cap');
});
