import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { workspace, tmpdir, BIN } from './helpers.js';
import { auditSummary, encodeProject } from '../src/core/audit.js';

const DAY = 86400000;
const NOW = Date.parse('2026-09-20T12:00:00.000Z');

/** A fictional Claude Code transcript line with tool_use blocks. */
function assistant({ at, cwd, session = 'sess-aaaa1111', calls }) {
  return JSON.stringify({
    type: 'assistant', timestamp: new Date(at).toISOString(), cwd, sessionId: session,
    message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }, ...calls.map(([id, name, input]) => ({ type: 'tool_use', id, name, input }))] },
  });
}

/** A fake config dir with one project folder holding two sessions and a subagent transcript. */
function fixture(root) {
  const config = tmpdir('flowrail-claude-');
  const dir = path.join(config, 'projects', encodeProject(root));
  fs.mkdirSync(path.join(dir, 'sess-bbbb2222', 'subagents'), { recursive: true });
  const a = [
    JSON.stringify({ type: 'user', timestamp: new Date(NOW - DAY).toISOString(), cwd: root, message: { content: 'push it' } }),
    assistant({ at: NOW - DAY, cwd: root, calls: [['t1', 'Bash', { command: 'npm test' }], ['t2', 'Bash', { command: 'git push origin main' }]] }),
    assistant({ at: NOW - DAY, cwd: root, calls: [['t2', 'Bash', { command: 'git push origin main' }]] }), // same block streamed twice
    assistant({ at: NOW - 2 * DAY, cwd: path.join(root, 'src'), calls: [['t3', 'Bash', { command: 'git reset --hard HEAD~3' }], ['t4', 'Read', { file_path: path.join(root, 'README.md') }]] }),
    assistant({ at: NOW - 40 * DAY, cwd: root, calls: [['t5', 'Bash', { command: 'git push --force' }]] }), // outside the window
    assistant({ at: NOW - DAY, cwd: '/somewhere/else', calls: [['t6', 'Bash', { command: 'git push' }]] }), // another project
    '{"type":"assistant","tool_use" torn',
  ];
  fs.writeFileSync(path.join(dir, 'sess-aaaa1111.jsonl'), a.join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'sess-bbbb2222', 'subagents', 'agent-1.jsonl'),
    assistant({ at: NOW - 3 * DAY, cwd: root, session: 'sess-bbbb2222', calls: [['t7', 'Read', { file_path: path.join(root, '.env') }]] }) + '\n');
  return config;
}

test('audit replays tool calls from this project\'s transcripts through the red lines', () => {
  const p = workspace();
  const env = { CLAUDE_CONFIG_DIR: fixture(p.root) };
  const r = auditSummary(p.root, { days: 30, env, now: NOW });
  assert.deepEqual(Object.keys(r).sort(), ['asked', 'byLine', 'calls', 'days', 'held', 'sessions', 'transcriptsDir', 'vsSettings']);
  assert.deepEqual(r.vsSettings, { rules: 0, hooks: 0, caught: 0, added: 3 });
  assert.equal(r.days, 30);
  assert.equal(r.calls, 5, 'npm test, git push, reset, Read README, Read .env; no duplicate, no old call, no other project');
  assert.equal(r.sessions, 2);
  assert.equal(r.transcriptsDir, path.join(env.CLAUDE_CONFIG_DIR, 'projects'));
  assert.deepEqual(r.held.map((e) => [e.line, e.subject, e.severity]), [['no-destructive-git', 'git reset --hard HEAD~3', 'block']]);
  assert.deepEqual(r.asked.map((e) => [e.line, e.severity]), [['no-push-without-asking', 'ask'], ['no-secrets-in-repo', 'ask']]);
  const env_ = r.asked.find((e) => e.line === 'no-secrets-in-repo');
  assert.equal(env_.subject, '.env', 'paths are relative to the project');
  assert.equal(env_.tool, 'Read');
  assert.equal(env_.session, 'sess-bbb');
  assert.deepEqual(Object.keys(r.held[0]).sort(), ['at', 'line', 'session', 'severity', 'subject', 'tool']);
  assert.deepEqual(r.byLine, { 'no-push-without-asking': 1, 'no-destructive-git': 1, 'no-secrets-in-repo': 1 });
  // A shorter window drops the older calls.
  assert.equal(auditSummary(p.root, { days: 1, env, now: NOW }).calls, 2);
});

test('audit subtracts what settings.json permissions would have caught', () => {
  const p = workspace({ minimal: true });
  const env = { CLAUDE_CONFIG_DIR: fixture(p.root) };
  const settings = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
  settings.permissions = { deny: ['Bash(git reset --hard:*)'], ask: ['Read(./.env)'] };
  settings.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: './mine.sh' }] });
  fs.writeFileSync(p.settings, JSON.stringify(settings));
  const r = auditSummary(p.root, { days: 30, env, now: NOW });
  assert.deepEqual(r.vsSettings, { rules: 2, hooks: 1, caught: 2, added: 1 });
  assert.equal(r.held[0].settings, 'deny');
  assert.equal(r.asked.find((e) => e.line === 'no-secrets-in-repo').settings, 'ask');
  assert.equal(r.asked.find((e) => e.line === 'no-push-without-asking').settings, undefined);
  const out = spawnSync(process.execPath, [BIN, 'audit'], { cwd: p.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', ...env } }).stdout;
  assert.match(out, /Last 30 days/);
  assert.equal(auditSummary(p.root, { days: 30, env, now: NOW, settings: false }).vsSettings, undefined);
});

test('audit without transcripts says so instead of failing', () => {
  const p = workspace();
  const r = auditSummary(p.root, { env: { CLAUDE_CONFIG_DIR: tmpdir('flowrail-empty-') } });
  assert.equal(r.calls, 0);
  assert.match(r.note, /No Claude Code transcripts for this project/);
});

test('flowrail audit prints the summary and --json the contract', () => {
  const p = workspace();
  // The fixture is dated relative to NOW; move its timestamps to "yesterday" for the real clock.
  const config = fixture(p.root);
  for (const f of walk(path.join(config, 'projects'))) {
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/"timestamp":"([^"]+)"/g, (_m, t) => `"timestamp":"${new Date(Date.parse(t) - NOW + Date.now()).toISOString()}"`));
  }
  const run = (args) => spawnSync(process.execPath, [BIN, 'audit', ...args], { cwd: p.root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', CLAUDE_CONFIG_DIR: config } });
  const out = run([]).stdout;
  assert.match(out, /Last 30 days: 5 tool calls in 2 sessions\./);
  assert.match(out, /would have held 1 \(1 no-destructive-git\) and asked first on 2 \(1 no-push-without-asking, 1 no-secrets-in-repo\)/);
  assert.match(out, /Read-only/);
  assert.equal(JSON.parse(run(['--json']).stdout).calls, 5);
});

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
