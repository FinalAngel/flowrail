// flowrail:allow-secrets (fake keys in fixtures)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/guard/shell.js';
import { decide, validateLines, toolMatches, globToRegex, stateOf, stateCounts, describe, summaryOf, redact } from '../src/core/redlines.js';
import { starterLines, scanRules } from '../src/core/recipes.js';

const lines = starterLines();
const ctx = { root: '/work/project', cwd: '/work/project' };
const bash = (command) => decide(lines, 'Bash', { command }, ctx).decision;

test('no-push-without-asking holds every bypass variant', () => {
  for (const cmd of [
    'git push', 'git push origin main', 'git -C . push', '/usr/bin/git push', 'command git push',
    'git -c core.x=y push', 'cd x && git push', 'sh -c "git push"', "bash -lc 'git push --tags'",
    'FOO=1 git push', 'sudo git push', 'env -i A=b git --no-pager push', 'git --git-dir=.git push',
    'true; git push', 'ls | git push', 'echo $(git push)', 'echo `git push`', 'timeout 10 git push',
    'sudo -u deploy git push', 'nohup git push &', 'eval "git push"', '(git push)', 'if true; then git push; fi',
    'git\\\n push', 'exec git push', 'xargs git push',
  ]) {
    assert.equal(bash(cmd), 'ask', cmd);
  }
});

test('no-push-without-asking leaves lookalikes alone', () => {
  for (const cmd of ['git commit -m "push the fix"', 'git status', 'npm run push-docs', 'echo "do not git push"', 'git log --grep push', 'grep -r "git push" docs']) {
    assert.equal(bash(cmd), 'allow', cmd);
  }
});

test('block beats ask when both match', () => {
  assert.equal(bash('git push --force origin main'), 'deny');
  assert.equal(bash('git push -f'), 'deny');
  assert.equal(bash('git reset --hard HEAD~1'), 'deny');
  assert.equal(bash('git clean -fdx'), 'deny');
  assert.equal(bash('git branch -D feature'), 'deny');
  assert.equal(bash('git branch -d feature'), 'allow');
});

test('rm -rf on root, home, everything or outside the project is blocked, project folders are not', () => {
  for (const cmd of ['rm -rf /', 'rm -rf ~', 'rm -rf ~/', 'rm -fr *', 'sudo rm -rf /', 'rm -r -f /', 'rm -rf .', 'rm -rf ../..', 'rm -rf ${HOME}', 'rm -rf /Users']) assert.equal(bash(cmd), 'deny', cmd);
  for (const cmd of ['rm -rf ./build', 'rm -rf dist', 'rm -f /tmp/x.log', 'rm -r dist']) assert.equal(bash(cmd), 'allow', cmd);
});

test('file tools: secret writes block, secret reads ask, templates pass', () => {
  assert.equal(decide(lines, 'Write', { file_path: '/work/project/.env' }, ctx).decision, 'deny');
  assert.equal(decide(lines, 'Edit', { file_path: '/work/project/config/.env.production' }, ctx).decision, 'deny');
  assert.equal(decide(lines, 'Write', { file_path: '/work/project/.env.example' }, ctx).decision, 'allow');
  assert.equal(decide(lines, 'Read', { file_path: '/work/project/.env' }, ctx).decision, 'ask');
});

test('a line with severity ask never blocks, even when its builtin would', () => {
  const soft = [{ id: 'g', title: 'g', severity: 'ask', hook: { tool: 'Bash', builtin: 'git-destructive' } }];
  assert.equal(decide(soft, 'Bash', { command: 'git reset --hard' }).decision, 'ask');
});

test('summaries are plain English: builtins describe what they hold, regex lines use why', () => {
  const [push, destructive] = describe(lines, true);
  assert.equal(push.summary, 'Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync, and git aliases that push)');
  assert.match(destructive.summary, /^Blocks force pushes, hard resets, forced cleans/);
  assert.equal(push.builtin, 'git-push');
  assert.equal(summaryOf({ id: 'x', title: 'Ask before deploying', why: 'Deploys change what users see.', severity: 'ask', hook: { tool: 'Bash', match: 'x' } }), 'Deploys change what users see.');
});

test('redact hides credentials in logged commands', () => {
  const r = redact('curl -u x https://me:pw@host/a?api_key=abc&x=1 -H "Authorization: Bearer abcdefghijk" ghp_0123456789abcdefghijABCDEFGHIJ');
  for (const leak of ['me:pw', 'abc&', 'abcdefghijk', 'ghp_0123']) assert.ok(!r.includes(leak), `${leak} in ${r}`);
  assert.equal(redact('rm -rf src/components/deeply/nested/folder/structure/file.js'), 'rm -rf src/components/deeply/nested/folder/structure/file.js');
});

test('warn severity and raw matching', () => {
  const l = [{ id: 'w', title: 'W', severity: 'warn', hook: { tool: 'Bash', match: 'DROP TABLE', flags: 'i', raw: true } }];
  assert.equal(decide(l, 'Bash', { command: 'psql -c "drop table users"' }).decision, 'warn');
});

test('toolMatches supports *, alternation and wildcards', () => {
  assert.ok(toolMatches('*', 'Bash'));
  assert.ok(toolMatches('Write|Edit', 'Edit'));
  assert.ok(!toolMatches('Write|Edit', 'Bash'));
  assert.ok(toolMatches('mcp__*', 'mcp__mail__send'));
});

test('a broken hook fails closed: it asks, it never allows or blocks', () => {
  const l = [{ id: 'bad', title: 'x', severity: 'block', hook: { tool: 'Bash', match: '(' } }];
  const r = decide(l, 'Bash', { command: 'ls' });
  assert.equal(r.decision, 'ask');
  assert.match(r.broken, /does not compile/);
  assert.equal(decide([...l, ...lines], 'Bash', { command: 'git reset --hard' }).decision, 'deny', 'other lines still hold');
});

test('validateLines reports bad input', () => {
  assert.deepEqual(validateLines(lines), []);
  assert.ok(validateLines('nope').length);
  const errs = validateLines([{ id: 'Bad Id', title: '', severity: 'maybe', hook: { tool: 'Bash', match: '(' } }]);
  assert.ok(errs.length >= 4, errs.join('\n'));
  assert.match(validateLines([{ id: 'a', title: 'a', severity: 'ask', hook: { builtin: 'nope' } }])[0], /builtin "nope" is unknown/);
  assert.deepEqual(validateLines([{ id: 'a', title: 'a', severity: 'ask', hook: { builtin: 'git-push' } }]), []);
});

test('globToRegex', () => {
  assert.ok(globToRegex('**/*.md').test('README.md'));
  assert.ok(globToRegex('**/*.md').test('docs/a/b.md'));
  assert.ok(!globToRegex('*.md').test('docs/b.md'));
  assert.ok(globToRegex('src/**/*.{js,ts}').test('src/a/b.ts'));
});

test('normalize strips wrappers but keeps arguments', () => {
  assert.deepEqual(normalize('cd app && sudo /usr/bin/git -C . push origin main'), ['cd app', 'git push origin main']);
  assert.deepEqual(normalize('git commit -m "push the fix"'), ['git commit -m "push the fix"']);
  assert.deepEqual(normalize('echo hi > out.txt 2>&1'), ['echo hi > out.txt >& 1']);
});

test('heredoc bodies are data unless they are fed to a shell', () => {
  assert.equal(bash("git commit -F- <<'EOF'\nnever git push\nEOF"), 'allow');
  assert.equal(bash("cat <<EOF | sh\ngit push\nEOF"), 'ask');
  assert.equal(bash("bash <<'EOF'\ngit push\nEOF"), 'ask');
  assert.equal(bash("git commit -m \"$(cat <<'EOF'\ndon't push\nEOF\n)\" && git push"), 'ask', 'an unbalanced quote in a heredoc does not hide what follows');
});

test('scanRules finds imperative rules and proposes recipes', () => {
  const { rules, proposals } = scanRules('# Rules\n\n- Never push without asking.\n- Do not deploy on Fridays.\n- Use tabs.\n```\nnever run this\n```\n');
  assert.equal(rules.length, 2);
  assert.deepEqual(proposals.map((p) => p.recipe.id), ['no-push-without-asking', 'no-deploy-without-asking']);
  assert.equal(proposals[0].quote, 'Never push without asking');
});

test('state model: armed, not-enforced, checked, declared', () => {
  const hook = { id: 'a', hook: { tool: 'Bash', match: 'x' } };
  const both = { id: 'b', hook: { tool: 'Bash', match: 'x' }, check: { pattern: 'y' } };
  const check = { id: 'c', check: { pattern: 'y' } };
  const none = { id: 'd' };
  assert.deepEqual([hook, both, check, none].map((l) => stateOf(l, true)), ['armed', 'armed', 'checked', 'declared']);
  assert.deepEqual([hook, both, check, none].map((l) => stateOf(l, false)), ['not-enforced', 'not-enforced', 'checked', 'declared']);
  assert.deepEqual(stateCounts([hook, check, none], false), { armed: 0, checked: 1, declared: 1, 'not-enforced': 1 });
});

test('flowrail check scans file contents for secrets when secret-files is armed, redacted and deduplicated', async () => {
  const { runChecks } = await import('../src/core/redlines.js');
  const fs = (await import('node:fs')).default;
  const path = (await import('node:path')).default;
  const { tmpdir } = await import('./helpers.js');
  const root = tmpdir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "const k = 'AKIAQWERTYUIOPASDFGH';\nconst ok = 'AKIAIOSFODNN7EXAMPLE';\n");
  fs.writeFileSync(path.join(root, 'id.txt'), '-----BEGIN RSA PRIVATE KEY-----\n');
  const p = { root, checkCache: path.join(root, '.flowrail', 'check.json') };
  const { results } = runChecks(p, starterLines());
  const secrets = results.filter((r) => r.id === 'no-secrets-in-repo');
  assert.deepEqual(secrets.map((r) => `${r.file}:${r.line}`).sort(), ['id.txt:1', 'src/app.js:1']);
  assert.ok(!JSON.stringify(results).includes('AKIAQWERTYUIOPASDFGH'), 'the key itself is not printed');
  assert.match(secrets.find((r) => r.file === 'src/app.js').message, /AWS access key/);
  // A fixtures file opts out of the scan with the marker near its top.
  fs.writeFileSync(path.join(root, 'src', 'app.js'), "// flowrail:allow-secrets\nconst k = 'AKIAQWERTYUIOPASDFGH';\n");
  assert.deepEqual(runChecks(p, starterLines()).results.filter((r) => r.id === 'no-secrets-in-repo').map((r) => r.file), ['id.txt']);
});
