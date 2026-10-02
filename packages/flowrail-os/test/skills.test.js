// The Skills page's catalog: project, personal and enabled-plugin skills and commands, nothing else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { catalog } from '../src/core/skills.js';
import { workspace, tmpdir } from './helpers.js';

const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('lists project, personal and enabled-plugin skills and commands, each once', () => {
  const p = workspace();
  const cfg = tmpdir();
  const before = new Set(catalog(p, { CLAUDE_CONFIG_DIR: cfg }).skills.map((s) => s.name)); // what init ships
  write(path.join(p.root, '.claude/skills/release/SKILL.md'), '---\nname: release\ndescription: >\n  Cut a release,\n  then tag it.\n---\n');
  write(path.join(p.root, '.claude/commands/standup.md'), '---\ndescription: Write the standup\n---\n');
  write(path.join(cfg, 'skills/tdd/SKILL.md'), '---\nname: tdd\ndescription: Test first.\n---\n');
  // A personal skill that is a symlink to the project's is the project's, listed once.
  fs.symlinkSync(path.join(p.root, '.claude/skills/release'), path.join(cfg, 'skills/release'));
  const on = path.join(cfg, 'plugins/cache/on'), off = path.join(cfg, 'plugins/cache/off');
  write(path.join(on, 'skills/seo/SKILL.md'), '---\nname: seo\ndescription: Audit a site.\n---\n');
  write(path.join(on, 'commands/fix.md'), 'Fix what the audit found.\n');
  write(path.join(off, 'skills/nope/SKILL.md'), '---\nname: nope\n---\n');
  write(path.join(cfg, 'plugins/installed_plugins.json'), JSON.stringify({ version: 2, plugins: {
    'on@market': [{ scope: 'user', installPath: on }],
    'off@market': [{ scope: 'user', installPath: off }],
  } }));
  write(path.join(cfg, 'settings.json'), JSON.stringify({ enabledPlugins: { 'on@market': true, 'off@market': false } }));

  const all = catalog(p, { CLAUDE_CONFIG_DIR: cfg });
  const skills = all.skills.filter((s) => !before.has(s.name));
  const counts = { ...all.counts, project: all.counts.project - before.size };
  assert.deepEqual(skills.map((s) => [s.name, s.kind, s.source, s.path || null]), [
    ['/on:fix', 'command', 'plugin', null],
    ['/standup', 'command', 'project', '.claude/commands/standup.md'],
    ['on:seo', 'skill', 'plugin', null],
    ['release', 'skill', 'project', '.claude/skills/release/SKILL.md'],
    ['tdd', 'skill', 'user', null],
  ]);
  assert.equal(skills.find((s) => s.name === 'release').description, 'Cut a release, then tag it.');
  assert.equal(skills.find((s) => s.name === '/on:fix').description, 'Fix what the audit found.');
  assert.deepEqual(counts, { project: 2, user: 1, plugin: 2 });
  assert.ok(skills.every((s) => !('file' in s)), 'no absolute paths reach the browser');
});
