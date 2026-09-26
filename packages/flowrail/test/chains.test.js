// flowrail:allow-secrets (fake keys in fixtures)
// Multi-step tamper chains, run for real: a temp project set up by `flowrail guard init`, and every
// step piped through the vendored hook exactly as Claude Code calls it (the command from
// .claude/settings.json, run by sh, with CLAUDE_PROJECT_DIR set). Each chain asserts that the
// step that would switch the guard off is held, or that the next step is. docs/tamper-model.md
// lists the same chains with their status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planInit, apply } from '../src/core/init.js';
import { paths } from '../src/core/paths.js';
import { hooksStatus } from '../src/core/hooks.js';
import { verifyJournal } from '../src/core/journal.js';
import { tmpdir } from './helpers.js';
import { acceptRules } from '../src/guard/state.js';

function project({ lines } = {}) {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  if (lines) {
    fs.writeFileSync(path.join(root, 'flowrail', 'red-lines.json'), JSON.stringify(lines));
    acceptRules(root, 'test');
  }
  return root;
}

const preToolUse = (root) => JSON.parse(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8')).hooks.PreToolUse.at(-1).hooks[0].command;

/** One tool call through the hook command in .claude/settings.json. Returns 'allow' | 'ask' | 'deny' | 'blocked'. */
function call(root, tool, input, { cwd = root, env = {} } = {}) {
  const r = spawnSync('/bin/sh', ['-c', preToolUse(root)], {
    cwd,
    input: JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: 'chain' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, ...env },
  });
  if (r.status === 2) return 'blocked';
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision || 'warn' : 'allow';
}
const bash = (root, command, opts) => call(root, 'Bash', { command }, opts);
const held = (d) => d === 'ask' || d === 'deny' || d === 'blocked';

test('fresh clone, no npm install, no node_modules: the guard holds', () => {
  const root = project();
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'ignore' });
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  const clone = path.join(tmpdir(), 'clone');
  git(path.dirname(clone), 'clone', '-q', root, clone);
  assert.ok(!fs.existsSync(path.join(clone, 'node_modules')));
  assert.equal(bash(clone, 'git push origin main'), 'ask');
  assert.equal(bash(clone, 'git push --force'), 'deny');
  assert.equal(bash(clone, 'git status'), 'allow');
  assert.equal(hooksStatus(paths(clone)).healthy, true);
});

test('chain: delete or edit the guard, then push', () => {
  const root = project();
  for (const cmd of ['rm -rf .claude/flowrail', 'rm .claude/flowrail/guard/hook.mjs', "sed -i '' '1s/^/process.exit(0);/' .claude/flowrail/guard/hook.mjs", "echo 'process.exit(0)' > .claude/flowrail/guard/hook.mjs", 'mv .claude/flowrail /tmp/x', 'git checkout HEAD -- .claude/flowrail/guard']) assert.ok(held(bash(root, cmd)), cmd);
  assert.ok(held(call(root, 'Write', { file_path: path.join(root, '.claude/flowrail/guard/hook.mjs'), content: 'process.exit(0)' })));
  // Suppose it happened anyway (a human did it by hand): the hook command fails closed.
  fs.rmSync(path.join(root, '.claude', 'flowrail'), { recursive: true });
  assert.equal(bash(root, 'git push --force'), 'blocked');
  assert.equal(hooksStatus(paths(root)).healthy, false);
});

test('the committed hook command fails closed on a neutered guard: emptied, garbled, prefixed, deleted, manifest edited, no node', () => {
  const guard = (root, f = '') => path.join(root, '.claude', 'flowrail', 'guard', f);
  const cases = {
    'every guard file emptied': (root) => {
      for (const f of fs.readdirSync(guard(root), { recursive: true })) if (/\.m?js$/.test(f)) fs.writeFileSync(guard(root, f), '');
    },
    'garbage in hook.mjs': (root) => fs.writeFileSync(guard(root, 'hook.mjs'), '{{{ not javascript'),
    'process.exit(0) prepended': (root) => fs.writeFileSync(guard(root, 'hook.mjs'), 'process.exit(0);\n' + fs.readFileSync(guard(root, 'hook.mjs'), 'utf8')),
    'hook.mjs deleted': (root) => fs.rmSync(guard(root, 'hook.mjs')),
    'guard folder deleted': (root) => fs.rmSync(guard(root), { recursive: true }),
    'manifest edited': (root) => fs.writeFileSync(guard(root, 'manifest.json'), '{"files":{}}'),
    'a file and its manifest entry rewritten to match': (root) => {
      fs.writeFileSync(guard(root, 'rules.js'), 'export const decide = () => ({ decision: "allow" });');
      const m = JSON.parse(fs.readFileSync(guard(root, 'manifest.json'), 'utf8'));
      m.files['rules.js'] = createHash('sha256').update(fs.readFileSync(guard(root, 'rules.js'))).digest('hex');
      fs.writeFileSync(guard(root, 'manifest.json'), JSON.stringify(m, null, 2) + '\n');
    },
  };
  for (const [name, neuter] of Object.entries(cases)) {
    const root = project();
    assert.equal(bash(root, 'git push --force origin main'), 'deny', `${name}: before`);
    neuter(root);
    assert.equal(bash(root, 'git push --force origin main'), 'blocked', name);
  }
  const root = project();
  assert.equal(bash(root, 'git push --force origin main', { env: { PATH: '/nonexistent' } }), 'blocked', 'node not on PATH');
});

test('chain: neuter the guard through globs, loops, piped file lists and copied trees, then push', () => {
  const root = project();
  const evil = tmpdir();
  fs.mkdirSync(path.join(evil, '.claude'));
  fs.writeFileSync(path.join(evil, '.claude', 'settings.json'), '{}');
  const clean = tmpdir();
  fs.writeFileSync(path.join(clean, 'a.txt'), 'x');
  for (const cmd of [
    'for f in .claude/*/*/*.mjs; do cp /dev/null "$f"; done',
    'for f in .claude/*/*/*.js .claude/*/*/*/*.js; do : > "$f"; done',
    'find . -name "hook.m*" | xargs truncate -s0',
    'find .claude -type f | xargs rm',
    'git ls-files .claude | xargs sed -i "" s/a/b/',
    'find .claude -type f | while read f; do : > "$f"; done',
    `cp -r ${evil}/.claude .`,
    `rsync -a ${evil}/ ./`,
    `cp -a ${evil}/. .`,
    'tar -xf /tmp/payload.tar',
  ]) assert.equal(bash(root, cmd), 'ask', cmd);
  for (const cmd of [`rsync -a ${clean}/ ./`, `cp -r ${clean}/. .`, 'find . -name "*.md" | xargs wc -l', 'for f in src/*.js; do cat "$f"; done']) {
    assert.equal(bash(root, cmd), 'allow', cmd);
  }
});

test('chain: rewrite a hook script of your own that settings.json runs', () => {
  const root = project();
  fs.mkdirSync(path.join(root, '.claude', 'hooks'));
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'mine.sh'), '#!/bin/sh\nexit 0\n');
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'other.sh'), '#!/bin/sh\nexit 0\n');
  const file = path.join(root, '.claude', 'settings.json');
  const s = JSON.parse(fs.readFileSync(file, 'utf8'));
  s.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/mine.sh' }] });
  fs.writeFileSync(file, JSON.stringify(s, null, 2));
  assert.equal(call(root, 'Write', { file_path: '.claude/hooks/mine.sh', content: 'exit 0' }), 'ask');
  assert.equal(bash(root, 'echo "exit 0" > .claude/hooks/mine.sh'), 'ask');
  assert.equal(call(root, 'Write', { file_path: '.claude/hooks/other.sh', content: 'exit 0' }), 'allow', 'a script no hook runs');
});

test('chain: edit the installed npm package or its bin, then push (the guard no longer lives there)', () => {
  const root = project();
  fs.mkdirSync(path.join(root, 'node_modules', 'flowrail', 'src', 'cli'), { recursive: true });
  assert.ok(held(call(root, 'Write', { file_path: 'node_modules/flowrail/src/cli/hook.js', content: 'process.exit(0)' })));
  assert.ok(held(bash(root, "sed -i '' '1s/^/process.exit(0);/' node_modules/flowrail/src/cli/hook.js")));
  assert.ok(held(call(root, 'Write', { file_path: 'node_modules/.bin/flowrail', content: '' })));
  assert.equal(bash(root, 'rm -rf node_modules && npm ci'), 'allow', 'reinstalling dependencies is fine');
});

test('chain: empty the red lines (file or API), then push: the floor still guards the guard', () => {
  const root = project({ lines: [] });
  assert.equal(bash(root, 'git push --force'), 'allow', 'with 0 lines of your own nothing else is held (doctor and the pill say so)');
  assert.equal(call(root, 'Write', { file_path: 'flowrail/red-lines.json', content: '[]' }), 'ask');
  assert.equal(call(root, 'Edit', { file_path: '.claude/settings.json', old_string: 'x', new_string: 'y' }), 'ask');
  assert.equal(bash(root, 'rm -rf .claude/flowrail'), 'ask');
  // A red-lines.json that tries to lower protect-flowrail cannot: the floor asks anyway.
  fs.writeFileSync(path.join(root, 'flowrail', 'red-lines.json'), JSON.stringify([{ id: 'protect-flowrail', title: 'x', severity: 'warn', hook: { tool: '*', builtin: 'flowrail-tamper' } }]));
  assert.equal(call(root, 'Write', { file_path: 'flowrail/red-lines.json', content: '[]' }), 'ask');
});

test('chain: a script that scrapes the dashboard token and saves [] (write it, run it)', () => {
  const root = project();
  const script = "const html = await (await fetch('http://127.0.0.1:4747/')).text();\nawait fetch('http://127.0.0.1:4747/api/redlines', { method: 'POST' });\n";
  assert.equal(call(root, 'Write', { file_path: 't.mjs', content: script }), 'ask', 'step 1 is held');
  fs.writeFileSync(path.join(root, 't.mjs'), script); // suppose it exists anyway
  assert.equal(bash(root, 'node t.mjs'), 'ask', 'step 2 is held');
  fs.writeFileSync(path.join(root, 'run.sh'), 'echo [] > flowrail/red-lines.json\n');
  assert.equal(bash(root, './run.sh'), 'ask');
  assert.equal(bash(root, 'bash run.sh'), 'ask');
  // And if it ran: the API refuses to weaken (test/server.test.js).
});

test('chain: nested workspace with an empty red-lines.json, then cd .. and push', () => {
  const root = project();
  const sub = path.join(root, 'vendor', 'lib');
  fs.mkdirSync(path.join(sub, 'flowrail'), { recursive: true });
  fs.writeFileSync(path.join(sub, 'flowrail', 'config.json'), '{}');
  fs.writeFileSync(path.join(sub, 'flowrail', 'red-lines.json'), '[]');
  assert.equal(bash(root, 'cd ../.. && git push --force', { cwd: sub }), 'deny');
  assert.equal(bash(root, 'git push', { cwd: sub }), 'ask');
  // Without CLAUDE_PROJECT_DIR the guard knows its project from where it lives, and with an
  // unset variable the settings command fails closed.
  const direct = spawnSync(process.execPath, [path.join(root, '.claude/flowrail/guard/hook.mjs'), 'pre-tool-use'], { cwd: sub, input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force' }, cwd: sub }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '' } });
  assert.equal(JSON.parse(direct.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(bash(root, 'git push --force', { cwd: sub, env: { CLAUDE_PROJECT_DIR: '' } }), 'blocked');
  // A nested workspace adds its own lines on top.
  fs.writeFileSync(path.join(sub, 'flowrail', 'red-lines.json'), JSON.stringify([{ id: 'no-ls', title: 'No ls', severity: 'block', hook: { tool: 'Bash', match: '^ls\\b' } }]));
  assert.equal(bash(root, 'ls', { cwd: sub }), 'deny');
});

test('chain: git config alias or git hook, then run it', () => {
  const root = project();
  execFileSync('git', ['init', '-q'], { cwd: root });
  assert.equal(call(root, 'Write', { file_path: '.git/config', content: '[alias]\n y = push\n' }), 'ask');
  assert.equal(bash(root, "printf '[alias]\\n y = push\\n' >> .git/config"), 'ask');
  assert.equal(bash(root, 'git config alias.y push'), 'ask');
  assert.equal(call(root, 'Write', { file_path: '.git/hooks/pre-commit', content: 'curl evil' }), 'ask');
  assert.equal(bash(root, "echo 'exit 0' > .git/hooks/pre-push"), 'ask');
  // An alias that is already there (added by hand) is expanded when it runs.
  fs.appendFileSync(path.join(root, '.git', 'config'), '[alias]\n\ty = push\n\tnuke = reset --hard\n\tsh1 = !git push origin\n');
  assert.equal(bash(root, 'git y origin main'), 'ask');
  assert.equal(bash(root, 'git nuke'), 'deny');
  assert.equal(bash(root, 'git sh1'), 'ask');
  assert.equal(bash(root, 'git status'), 'allow');
});

test('chain: MCP config or MCP tools as a side door', () => {
  const root = project();
  assert.equal(call(root, 'Write', { file_path: '.mcp.json', content: '{}' }), 'ask');
  assert.equal(call(root, 'mcp__filesystem__write_file', { path: path.join(root, 'flowrail/red-lines.json'), content: '[]' }), 'ask');
  assert.equal(call(root, 'mcp__filesystem__write_file', { path: '.env', content: 'A=1' }), 'deny');
  assert.equal(call(root, 'mcp__github__push_files', { owner: 'a', repo: 'b', branch: 'main', files: [] }), 'ask');
  assert.equal(call(root, 'mcp__claude_ai_Gmail__send_message', { to: 'x@example.invalid' }), 'ask');
  assert.equal(call(root, 'mcp__github__get_pull_request', { pull_number: 1 }), 'allow');
});

test('chain: a symlink or hard link to a protected file, then write through it', () => {
  const root = project();
  assert.equal(bash(root, 'ln -s flowrail/red-lines.json r.json'), 'ask');
  assert.equal(bash(root, 'ln flowrail/red-lines.json hard.json'), 'ask');
  assert.equal(bash(root, 'ln -s flowrail/red-lines.json r.json && echo [] > r.json'), 'ask');
  fs.symlinkSync('flowrail/red-lines.json', path.join(root, 'r.json')); // suppose the link exists
  assert.equal(bash(root, 'echo [] > r.json'), 'ask');
  assert.equal(call(root, 'Write', { file_path: 'r.json', content: '[]' }), 'ask');
  fs.symlinkSync('.claude', path.join(root, 'c'));
  assert.equal(call(root, 'Write', { file_path: 'c/settings.json', content: '{}' }), 'ask');
});

test('chain: a symlink to home, then rm -rf through it', () => {
  const root = project();
  const h = path.join(fs.realpathSync(os.tmpdir()), `flowrail-h-${process.pid}`);
  assert.equal(bash(root, `ln -s ~ ${h} && rm -rf ${h}/`), 'deny');
  fs.symlinkSync(os.homedir(), h);
  try {
    assert.equal(bash(root, `rm -rf ${h}/`), 'deny');
    assert.equal(bash(root, `rm -rf ${h}/*`), 'deny');
    assert.equal(bash(root, `rm -f ${h}`), 'allow', 'removing the link itself is fine');
  } finally { fs.rmSync(h); }
});

test('chain: erase or edit the audit trail', () => {
  const root = project();
  const p = paths(root);
  assert.equal(bash(root, 'git push'), 'ask');
  assert.equal(call(root, 'Write', { file_path: '.flowrail/redlines.log', content: '' }), 'ask');
  assert.equal(bash(root, 'grep -v push .flowrail/redlines.log > x; mv x .flowrail/redlines.log'), 'ask');
  assert.ok(verifyJournal(p).ok, 'log and journal agree');
  fs.writeFileSync(p.redlinesLog, ''); // a human (or anything outside the guard) trims it anyway
  const j = verifyJournal(p);
  assert.equal(j.ok, false);
  assert.match(j.problems.join(' '), /missing from or changed/);
});

test('chain: forge a human comment, then start a session', () => {
  const root = project();
  assert.equal(call(root, 'Write', { file_path: '.flowrail/comments/README.md.json', content: '[]' }), 'ask');
});

test('chain: rewrite the managed block in CLAUDE.md', () => {
  const root = tmpdir();
  apply(root, planInit(root, { room: () => {} }).changes); // the control room writes the block
  const text = fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(call(root, 'Write', { file_path: 'CLAUDE.md', content: '# Just notes\n' }), 'ask');
  assert.equal(call(root, 'Edit', { file_path: 'CLAUDE.md', old_string: 'when one holds a call, stop and ask the human;', new_string: '' }), 'ask');
  assert.equal(call(root, 'Write', { file_path: 'CLAUDE.md', content: text + '\n- Use tabs.\n' }), 'allow', 'writing around the block is fine');
  assert.equal(call(root, 'Edit', { file_path: 'CLAUDE.md', old_string: 'flowrail guard', new_string: 'flowrail guard', replace_all: true }), 'allow');
  assert.equal(bash(root, 'echo "- Use tabs." >> CLAUDE.md'), 'allow');
  assert.equal(bash(root, 'echo x > CLAUDE.md'), 'ask');
  assert.equal(bash(root, "sed -i '' '/flowrail/d' CLAUDE.md"), 'ask');
});

test('chain: arguments from a pipe, variables and environment dumps', () => {
  const root = project();
  assert.equal(bash(root, 'printf push | xargs git'), 'ask');
  assert.equal(bash(root, 'x=push; git $x'), 'ask');
  assert.equal(bash(root, 'env'), 'ask');
  assert.equal(bash(root, 'printenv'), 'ask');
  assert.equal(bash(root, 'git reset --keep HEAD~1'), 'allow');
  assert.equal(bash(root, 'git reset --hard'), 'deny');
});

test('chain: write a secret into an ordinary file', () => {
  const root = project();
  assert.equal(call(root, 'Write', { file_path: 'src/app.js', content: "const k = 'AKIAQWERTYUIOPASDFGH';" }), 'deny');
  assert.equal(call(root, 'Write', { file_path: 'docs/aws.md', content: 'Example: AKIAIOSFODNN7EXAMPLE' }), 'allow');
});

test('a symlinked spelling of the project (macOS /var/folders is /private/var/folders) holds the same', () => {
  const root = project({ lines: [{ id: 'keep-content', title: 'keep content', severity: 'block', hook: { tool: '*', builtin: 'protect-path', params: { glob: 'content/**' } } }] });
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content', 'a.md'), 'a\n');
  const alias = path.join(tmpdir(), 'alias');
  fs.symlinkSync(root, alias);
  for (const [dir, cwd] of [[root, alias], [alias, alias], [alias, root]]) {
    const run = (tool, input) => {
      const r = spawnSync('/bin/sh', ['-c', preToolUse(root)], {
        cwd, input: JSON.stringify({ tool_name: tool, tool_input: input, cwd, session_id: 's' }), encoding: 'utf8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      });
      return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision : 'allow';
    };
    const where = `project ${dir === root ? 'real' : 'alias'}, cwd ${cwd === root ? 'real' : 'alias'}`;
    assert.equal(run('Bash', { command: 'rm content/a.md' }), 'deny', where);
    assert.equal(run('Bash', { command: 'git mv content/a.md b.md' }), 'deny', where);
    assert.equal(run('Bash', { command: `rm ${alias}/content/a.md` }), 'deny', where);
    assert.equal(run('Write', { file_path: `${cwd}/content/a.md`, content: 'x' }), 'deny', where);
    assert.equal(run('Write', { file_path: `${cwd}/flowrail/red-lines.json`, content: '[]' }), 'ask', where);
    assert.equal(run('Bash', { command: 'cat content/a.md' }), 'allow', where);
  }
});

test('a symlink into a protected folder or to a secret is the folder or the secret', () => {
  const root = project({ lines: [
    { id: 'keep-content', title: 'keep content', severity: 'block', hook: { tool: '*', builtin: 'protect-path', params: { glob: 'content/**' } } },
    { id: 'secrets', title: 'secrets', severity: 'block', hook: { tool: '*', builtin: 'secret-files' } },
  ] });
  fs.mkdirSync(path.join(root, 'content'));
  fs.writeFileSync(path.join(root, 'content', 'a.md'), 'a\n');
  fs.writeFileSync(path.join(root, '.env'), 'X=1\n');
  // made in the same command line
  assert.equal(bash(root, 'ln -s content c2; rm -rf c2/'), 'deny');
  assert.equal(bash(root, 'ln -s content c2 && rm -rf c2/a.md'), 'deny');
  assert.equal(bash(root, 'ln -s .env envlink; cat envlink'), 'ask');
  // made by an earlier call
  fs.symlinkSync('content', path.join(root, 'c3'));
  fs.symlinkSync('.env', path.join(root, 'envlink2'));
  assert.equal(bash(root, 'rm -rf c3/'), 'deny');
  assert.equal(bash(root, 'rm -rf c3/*'), 'deny');
  assert.equal(bash(root, 'echo x > c3/a.md'), 'deny');
  assert.equal(bash(root, 'cat envlink2'), 'ask');
  assert.equal(call(root, 'Read', { file_path: path.join(root, 'envlink2') }), 'ask');
  // removing the link itself is fine
  assert.equal(bash(root, 'rm c3'), 'allow');
  assert.equal(bash(root, 'cat content/a.md'), 'allow');
});

test('CLAUDE_CONFIG_DIR: its settings files are protected like ~/.claude, and disableAllHooks anywhere asks', () => {
  const root = project();
  const cfg = path.join(tmpdir(), 'claude-config');
  fs.mkdirSync(cfg);
  const env = { CLAUDE_CONFIG_DIR: cfg };
  assert.equal(call(root, 'Write', { file_path: path.join(cfg, 'settings.json'), content: '{"disableAllHooks":true}' }, { env }), 'ask');
  assert.equal(call(root, 'Edit', { file_path: path.join(cfg, 'settings.local.json'), old_string: '{', new_string: '{"hooks":{},' }, { env }), 'ask');
  assert.equal(bash(root, `echo '{}' > ${cfg}/settings.json`, { env }), 'ask');
  assert.equal(bash(root, 'echo {} > "$CLAUDE_CONFIG_DIR/settings.local.json"', { env }), 'ask');
  assert.equal(call(root, 'mcp__filesystem__write_file', { path: path.join(cfg, 'settings.json'), content: '{}' }, { env }), 'ask');
  assert.equal(bash(root, `cat ${cfg}/settings.json`, { env }), 'allow');
  // disableAllHooks in any settings file, wherever it lives
  const other = path.join(tmpdir(), 'elsewhere.json');
  assert.equal(call(root, 'Write', { file_path: other, content: '{\n  "disableAllHooks": true\n}' }), 'ask');
  assert.equal(bash(root, `jq '.disableAllHooks = true' a.json > ${other}`), 'ask');
});
