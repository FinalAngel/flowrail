import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { workspace, tmpdir, BIN, setLines } from './helpers.js';
import { stats } from '../src/core/redlines.js';

const env = { ...process.env, CLAUDE_PROJECT_DIR: '' };
const run = (kind, input, args = ['hook', kind]) => spawnSync(process.execPath, [BIN, ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env });
const call = (root, command, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root, session_id: 's-1', ...extra });
const decision = (r) => (r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : 'allow');

/** Pipe the input in after a delay, the way a slow writer would: (sleep 0.05; echo ...) | flowrail hook ... */
function runSlow(input, delayMs, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'hook', 'pre-tool-use'], { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    const text = JSON.stringify(input);
    setTimeout(() => {
      child.stdin.write(text.slice(0, 10));
      setTimeout(() => child.stdin.end(text.slice(10)), 20);
    }, delayMs);
  });
}

test('pre-tool-use denies, asks and logs', () => {
  const p = workspace({ minimal: true });
  const r = run('pre-tool-use', call(p.root, 'git -C . push origin main'));
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'ask');
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /no-push-without-asking/);

  const d = JSON.parse(run('pre-tool-use', call(p.root, 'git reset --hard')).stdout);
  assert.equal(d.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(d.hookSpecificOutput.permissionDecisionReason, /hard reset/);

  const log = fs.readFileSync(p.redlinesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log.length, 2);
  assert.equal(log[1].id, 'no-destructive-git');
});

test('slow stdin is read to the end: 50 ms and 500 ms delays still hold', async () => {
  const p = workspace({ minimal: true });
  for (const delay of [50, 500]) {
    const r = await runSlow(call(p.root, 'git push --force origin main'), delay, p.root);
    assert.equal(r.status, 0, `delay ${delay}`);
    assert.equal(decision(r), 'deny', `delay ${delay}: ${r.stdout} ${r.stderr}`);
  }
});

test('flowrail guard is the same hook', () => {
  const p = workspace({ minimal: true });
  assert.equal(decision(run('', call(p.root, 'git push'), ['guard'])), 'ask');
});

test('pre-tool-use says nothing for allowed calls', () => {
  const p = workspace({ minimal: true });
  const r = run('pre-tool-use', call(p.root, 'git status'));
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('warn prints a systemMessage without a decision', () => {
  const p = workspace({ minimal: true });
  setLines(p, JSON.stringify([{ id: 'w', title: 'Careful with ls', severity: 'warn', hook: { tool: 'Bash', match: '^ls\\b' } }]));
  const out = JSON.parse(run('pre-tool-use', call(p.root, 'ls -la')).stdout);
  assert.match(out.systemMessage, /Careful with ls/);
  assert.equal(out.hookSpecificOutput, undefined);
});

test('outside a workspace, bad input is no opinion; the hook never crashes', () => {
  const dir = tmpdir();
  for (const input of ['', 'not json', '[]', 'null', '{"tool_name":42}', JSON.stringify({ tool_name: 'Bash', tool_input: null, cwd: dir }), JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push' }, cwd: '/definitely/not/here' })]) {
    const r = spawnSync(process.execPath, [BIN, 'hook', 'pre-tool-use'], { input, encoding: 'utf8', env, cwd: dir });
    assert.equal(r.status, 0, input);
    assert.equal(r.stdout, '', input);
    assert.equal(r.stderr, '', input);
  }
});

test('inside a workspace, unreadable input asks instead of allowing', () => {
  const p = workspace({ minimal: true });
  const r = spawnSync(process.execPath, [BIN, 'hook', 'pre-tool-use'], { input: 'not json', encoding: 'utf8', env, cwd: p.root });
  assert.equal(r.status, 0);
  assert.equal(decision(r), 'ask');
  assert.match(r.stderr, /hook input could not be read/);
});

test('fail closed: a broken, missing or non-array red-lines.json asks on every call', () => {
  const p = workspace({ minimal: true });
  for (const [label, write] of [['broken', () => setLines(p, '{broken')], ['object', () => setLines(p, '{}')], ['missing', () => fs.rmSync(p.redlines)]]) {
    write();
    for (const cmd of ['git push', 'ls']) {
      const r = run('pre-tool-use', call(p.root, cmd));
      assert.equal(r.status, 0, label);
      assert.equal(decision(r), 'ask', `${label}: ${cmd}`);
      assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /red-lines\.json could not be read/, label);
      assert.match(r.stderr, /flowrail: red-lines\.json could not be read/, label);
    }
  }
});

test('fail closed: a regex that does not compile or an unknown builtin asks on its tools', () => {
  const p = workspace({ minimal: true });
  setLines(p, JSON.stringify([{ id: 'bad', title: 'x', severity: 'block', hook: { tool: 'Bash', match: '((' } }]));
  const r = run('pre-tool-use', call(p.root, 'echo hi'));
  assert.equal(decision(r), 'ask');
  assert.match(r.stderr, /cannot be checked/);
  assert.equal(decision(run('pre-tool-use', { ...call(p.root, ''), tool_name: 'Read', tool_input: { file_path: 'x' } })), 'allow', 'other tools are not affected');
  setLines(p, JSON.stringify([{ id: 'bad', title: 'x', severity: 'block', hook: { tool: '*', builtin: 'nope' } }]));
  assert.equal(decision(run('pre-tool-use', call(p.root, 'echo hi'))), 'ask');
});

test('calls without a session are probes: logged but not counted as holds; commands are redacted', () => {
  const p = workspace({ minimal: true });
  run('pre-tool-use', call(p.root, 'git push https://user:hunter2@example.invalid/repo.git', { session_id: undefined }));
  run('pre-tool-use', call(p.root, `git push && curl -H "Authorization: Bearer abcdefghijklmnop" ${p.root}/x?token=secret123`));
  const log = fs.readFileSync(p.redlinesLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(log[0].probe, true);
  assert.equal(log[1].probe, undefined);
  const text = JSON.stringify(log);
  for (const leak of ['hunter2', 'abcdefghijklmnop', 'secret123', p.root]) assert.ok(!text.includes(leak), leak);
  assert.match(log[1].subject, /curl -H "Authorization: Bearer \*\*\*" x\?token=\*\*\*/);
  const st = stats(p);
  assert.equal(st.held7d, 1);
  assert.equal(st.probes7d, 1);
});

test('file tools log the path relative to the project', () => {
  const p = workspace({ minimal: true });
  run('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: path.join(p.root, 'config', '.env') }, cwd: p.root, session_id: 's' });
  const e = JSON.parse(fs.readFileSync(p.redlinesLog, 'utf8').trim());
  assert.equal(e.path, 'config/.env');
  assert.equal(e.decision, 'deny');
});

test('protect-flowrail holds the agent editing its own guardrails', () => {
  const p = workspace({ minimal: true });
  assert.equal(decision(run('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: p.redlines }, cwd: p.root, session_id: 's' })), 'ask');
  assert.equal(decision(run('pre-tool-use', call(p.root, "echo '[]' > flowrail/red-lines.json"))), 'ask');
  assert.equal(decision(run('pre-tool-use', call(p.root, 'npx flowrail uninstall --yes'))), 'ask');
  assert.equal(decision(run('pre-tool-use', call(p.root, "curl -X POST -H 'X-Flowrail: 1' http://127.0.0.1:4747/api/redlines"))), 'ask');
});

test('subagent hook records agent state', () => {
  const p = workspace({ minimal: true });
  run('subagent', { cwd: p.root, hook_event_name: 'SubagentStart', agent_type: 'reviewer', session_id: 's' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.agents, 'reviewer.json'), 'utf8')).state, 'running');
  run('subagent', { cwd: p.root, hook_event_name: 'SubagentStop', agent_type: 'reviewer', session_id: 's' });
  assert.equal(JSON.parse(fs.readFileSync(path.join(p.agents, 'reviewer.json'), 'utf8')).state, 'done');
  run('subagent', { cwd: p.root, hook_event_name: 'SubagentStart', agent_type: '../../evil' });
  assert.ok(!fs.existsSync(path.join(p.root, 'evil.json')));
});

test('outside a workspace every hook is a no-op', () => {
  const dir = tmpdir();
  for (const k of ['pre-tool-use', 'session-start', 'subagent']) {
    const r = run(k, { cwd: dir, tool_name: 'Bash', tool_input: { command: 'git push' }, agent_type: 'x' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});
