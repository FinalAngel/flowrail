// flowrail:allow-secrets (fake keys in fixtures)
// Drift detection, executable git config, live dashboard ports, the machine state, and paths the
// guard resolves on disk, through the hook command exactly as Claude Code runs it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { planInit, planUpgrade, apply, tooling, stubId, withBlock, claudeBlock, BLOCK_START } from '../src/core/init.js';
import { paths } from '../src/core/paths.js';
import { hooksStatus } from '../src/core/hooks.js';
import { driftStatus, logChange, loadLines } from '../src/core/redlines.js';
import { verifyRedlines } from '../src/core/verify.js';
import { verifyJournal } from '../src/core/journal.js';
import { recipeFor, pathRule } from '../src/core/recipes.js';
import { run as doctor } from '../src/core/doctor.js';
import { stateDir, acceptRules } from '../src/guard/state.js';
import { decide } from '../src/guard/rules.js';
import { tmpdir, BIN } from './helpers.js';

function project() {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  return root;
}
const hookCmd = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'))
  .hooks.PreToolUse.at(-1).hooks[0].command;
/** One tool call through the hook command in .claude/settings.json: { decision, reason }. */
function call(root, tool, input) {
  const r = spawnSync('sh', ['-c', hookCmd(root)], {
    cwd: root,
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root, session_id: 'test' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  assert.equal(r.status, 0, r.stderr);
  const o = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { decision: o ? o.permissionDecision : 'allow', reason: o ? o.permissionDecisionReason : '' };
}
const bash = (root, command) => call(root, 'Bash', { command });
const cli = (cwd, args, env = {}) => spawnSync(process.execPath, [BIN, ...args], {
  cwd, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1', ...env },
});

test('drift: red-lines.json replaced by any writer (tar -x) makes every call ask until accepted, denies stay denies', () => {
  const root = project();
  const rl = path.join(root, 'flowrail', 'red-lines.json');
  assert.equal(bash(root, 'git status').decision, 'allow');
  // The netsec chain: build a tar with neutered rules, extract it over the project.
  const evil = tmpdir();
  fs.mkdirSync(path.join(evil, 'flowrail'));
  fs.writeFileSync(path.join(evil, 'flowrail', 'red-lines.json'), '[]\n');
  execFileSync('tar', ['-cf', path.join(evil, 'payload.tar'), '-C', evil, 'flowrail']);
  fs.copyFileSync(path.join(evil, 'payload.tar'), path.join(root, 'payload.tar'));
  assert.equal(bash(root, 'tar -xf payload.tar').decision, 'ask', 'the extraction itself is asked');
  execFileSync('tar', ['-xf', 'payload.tar'], { cwd: root }); // suppose the human said yes
  assert.equal(fs.readFileSync(rl, 'utf8'), '[]\n');
  // The last accepted red lines still hold: a deny stays a deny; everything else asks.
  assert.equal(bash(root, 'git push --force origin main').decision, 'deny');
  for (const cmd of ['git push origin main', 'cat .env', 'git status']) {
    const r = bash(root, cmd);
    assert.equal(r.decision, 'ask', cmd);
    assert.match(r.reason, /flowrail\/red-lines\.json changed outside flowrail/);
    assert.match(r.reason, /npx flowrail redlines accept/);
  }
  assert.deepEqual(driftStatus(root), { changed: true, files: ['flowrail/red-lines.json'] });
  assert.deepEqual(hooksStatus(paths(root)).drift.files, ['flowrail/red-lines.json']);
  // A flowrail write on top of drift does not launder it.
  logChange(paths(root), [], [], 'cli');
  assert.equal(driftStatus(root).changed, true);
  // The agent cannot accept for the human.
  assert.equal(bash(root, 'npx flowrail redlines accept').decision, 'ask');
  const refused = cli(root, ['redlines', 'accept'], { CLAUDECODE: '1' });
  assert.equal(refused.status, 1);
  assert.match(refused.stdout, /Refusing inside a Claude Code session/);
  const notTty = cli(root, ['redlines', 'accept'], { CLAUDECODE: '' });
  assert.equal(notTty.status, 1);
  assert.match(notTty.stdout, /Not an interactive terminal/);
  // The human accepts: the (empty) rules are enforced again, the floor still holds.
  acceptRules(root, 'test');
  assert.equal(bash(root, 'git push --force origin main').decision, 'allow');
  assert.equal(bash(root, 'rm flowrail/red-lines.json').decision, 'ask');
  assert.ok(verifyJournal(paths(root)).ok, 'accepted snapshots do not upset the audit log');
});

test('drift: config.json too; doctor reports it; dashboard and CLI changes are accepted', async () => {
  const root = project();
  const p = paths(root);
  fs.writeFileSync(p.config, JSON.stringify({ port: 9999 }));
  assert.match(bash(root, 'ls').reason, /flowrail\/config\.json changed outside flowrail/);
  const d = (await doctor(p, { serving: true })).find((c) => c.id === 'drift');
  assert.equal(d.status, 'fail');
  assert.match(d.fix, /redlines accept/);
  acceptRules(root, 'test');
  // `flowrail redlines add` (and a dashboard save through logChange) keeps the snapshot current.
  assert.equal(cli(root, ['redlines', 'add', 'no-deploy-without-asking']).status, 0);
  assert.equal(driftStatus(root).changed, false);
  assert.equal(bash(root, 'fly deploy').decision, 'ask');
});

test('drift: an edit of red-lines.json the human approved in Claude Code is accepted, not drift', () => {
  const root = project();
  const rl = path.join(root, 'flowrail', 'red-lines.json');
  const next = JSON.stringify([...loadLines(paths(root)), { id: 'x', title: 'x', severity: 'ask' }], null, 2);
  assert.equal(call(root, 'Write', { file_path: 'flowrail/red-lines.json', content: next }).decision, 'ask');
  fs.writeFileSync(rl, next); // the human approved it; Claude Code wrote it
  assert.equal(bash(root, 'git status').decision, 'allow', 'the approved content is accepted');
  // A pending edit is one-shot: a later write of the same content by another path is drift.
  assert.equal(call(root, 'Write', { file_path: 'flowrail/red-lines.json', content: '[]' }).decision, 'ask');
  assert.equal(bash(root, 'git status').decision, 'allow', 'denied: the file did not change');
  fs.writeFileSync(rl, '[]');
  assert.match(bash(root, 'git status').reason, /changed outside flowrail/);
});

test('git config that runs programs is held, through the hook, in every form', () => {
  const root = project();
  for (const cmd of [
    'git config core.hooksPath /tmp/h', 'git -c core.hooksPath=/tmp/h commit -m x',
    'git -c core.fsmonitor="sh -c evil" status', 'git config --global core.pager "sh -c x"',
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.y GIT_CONFIG_VALUE_0="!sh" git y',
  ]) assert.equal(bash(root, cmd).decision, 'ask', cmd);
  assert.equal(bash(root, 'git config user.name "A B"').decision, 'allow');
  assert.equal(bash(root, 'git -c color.ui=always log').decision, 'allow');
});

test('live dashboard ports from <stateDir>/ports.json are the dashboard API too', () => {
  const root = project();
  const file = path.join(stateDir(), 'ports.json');
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  try {
    assert.equal(bash(root, 'curl -s http://127.0.0.1:4871/').decision, 'allow');
    fs.writeFileSync(file, JSON.stringify({ ports: [4871], updated: new Date().toISOString() }));
    assert.equal(bash(root, 'curl -s http://127.0.0.1:4871/').decision, 'ask');
    assert.equal(bash(root, 'python3 -c "import urllib.request as u; u.urlopen(\'http://localhost:4871/api\')"').decision, 'ask');
  } finally {
    if (before === null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, before);
  }
});

test('a project under /tmp: rm -rf of its own parents is held, other temp folders are fine', () => {
  const root = project(); // tmpdir() is under the OS temp folder
  const lines = loadLines(paths(root));
  const d = (command) => decide(lines, 'Bash', { command }, { root, roots: [root], cwd: root, noFloor: true }).decision;
  assert.equal(d('rm -rf ../..'), 'deny');
  assert.equal(d(`rm -rf ${path.dirname(root)}`), 'deny');
  assert.equal(d(`rm -rf ${path.join(path.dirname(root), 'someone-elses-scratch')}`), 'allow');
  assert.equal(d('rm -rf build'), 'allow');
});

test('protect-path: Write over an existing file is held, a new file and Edit are not; find reaches', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '- Do not delete anything in content/.\n');
  apply(root, planInit(root, { accept: ['protect-path-content'] }).changes);
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content', 'post.md'), 'a');
  // "Do not" without a qualifier blocks (wording rules); "without asking" would ask.
  assert.equal(call(root, 'Write', { file_path: 'content/post.md', content: '' }).decision, 'deny');
  assert.equal(call(root, 'Write', { file_path: 'content/new.md', content: 'x' }).decision, 'allow');
  assert.equal(call(root, 'Edit', { file_path: 'content/post.md', old_string: 'a', new_string: 'b' }).decision, 'allow');
  assert.equal(bash(root, 'find . -name "*.log" -delete').decision, 'allow', 'no .log files in content/');
  assert.equal(bash(root, 'find . -name "*.md" -delete').decision, 'deny');
  assert.equal(bash(root, 'find content -delete').decision, 'deny');
  for (const cmd of ['rm content/post.md', 'echo x > content/post.md', 'mv content/post.md /tmp/', 'cd content && rm -rf .']) {
    assert.notEqual(bash(root, cmd).decision, 'allow', cmd);
  }
});

