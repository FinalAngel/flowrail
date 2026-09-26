import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { planInit, planUninstall, planUpgrade, apply, withBlock, withoutBlock, claudeBlock, BLOCK_START, mcpServers, detect, freshEpoch } from '../src/core/init.js';
import { hooksStatus, mergeHooks, hookCommand, GUARD_REL, GUARD_FILES, GUARD_SRC } from '../src/core/hooks.js';
import { paths } from '../src/core/paths.js';
import { describe } from '../src/core/redlines.js';
import { tmpdir, BIN } from './helpers.js';

const STARTERS = ['no-push-without-asking', 'no-destructive-git', 'no-secrets-in-repo', 'no-rm-rf-outside-project', 'protect-flowrail', 'ask-before-mcp-actions'];
/** The control room's init hook with no files of its own: guard init plus the CLAUDE.md block. */
const NO_FILES = () => {};
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const cli = (root, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: root, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });

const userSettings = {
  permissions: { allow: ['Bash(npm test)'] },
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './guard.sh' }] }], Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] },
};

function project() {
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(userSettings));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Notes\n\n- Never push without asking.\n- Do not deploy without approval.\n');
  fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/');
  return root;
}

test('init vendors the guard, hooks it into settings.json next to the user\'s own, and is idempotent', () => {
  const root = project();
  const first = planInit(root, { accept: ['no-deploy-without-asking'], room: NO_FILES });
  assert.ok(!first.changes.some((c) => c.kind === 'run'), 'init never runs npm');
  apply(root, first.changes);

  for (const f of [...GUARD_FILES, 'manifest.json']) assert.ok(fs.existsSync(path.join(root, GUARD_REL, f)), f);
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.deepEqual(s.permissions, userSettings.permissions);
  assert.equal(s.hooks.PreToolUse[0].hooks[0].command, './guard.sh');
  assert.equal(s.hooks.Stop[0].hooks[0].command, 'say done');
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, hookCommand('pre-tool-use'));
  assert.match(s.hooks.PreToolUse[1].hooks[0].command, /^node -e '\/\*flowrail-guard\*\/[^']+' pre-tool-use \|\| \{ echo .* >&2; exit 2; \}$/);
  assert.equal(s.hooks.PreToolUse[1].matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|mcp__.*');
  const commands = Object.values(s.hooks).flat().flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => /flowrail/.test(c));
  assert.equal(commands.length, 4);
  for (const c of commands) assert.doesNotMatch(c.replace(/ \|\| \{.*$/, ''), /npx|npm|node_modules|\/Users\/|\/home\/|\/tmp\/|\/var\//, 'no npm and no absolute path in the committed file');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.local.json')));
  const hs = hooksStatus(paths(root));
  assert.ok(hs.installed && hs.healthy, hs.problem);
  assert.deepEqual(hs.guard, { version: hs.guard.version, verified: true, changed: [] });

  const lines = JSON.parse(read(root, 'flowrail/red-lines.json'));
  assert.deepEqual(lines.map((l) => l.id), [...STARTERS, 'no-deploy-without-asking']);
  assert.equal(read(root, '.gitignore'), 'node_modules/\n# flowrail per-machine state (comments, runs, logs)\n.flowrail/\n');
  assert.equal(read(root, 'CLAUDE.md').split(BLOCK_START).length, 2);
  assert.doesNotMatch(read(root, 'CLAUDE.md'), /--no-install/);

  assert.deepEqual(planInit(root, { room: NO_FILES }).changes, [], 'second run changes nothing');
  assert.deepEqual(planUpgrade(root).changes, [], 'upgrade on a current install changes nothing');
});

test('init refuses to rewrite an invalid settings.json', () => {
  const root = project();
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), '{ nope');
  const plan = planInit(root, { room: NO_FILES });
  assert.ok(plan.problems.some((p) => /not valid JSON/.test(p)));
  assert.ok(!plan.changes.some((c) => c.path === '.claude/settings.json'));
});

test('guard init (--minimal) is the guard, red lines and hooks only, with or without package.json', () => {
  for (const withPkg of [false, true]) {
    const root = tmpdir();
    if (withPkg) fs.writeFileSync(path.join(root, 'package.json'), '{"name":"x"}');
    const plan = planInit(root, { minimal: true });
    assert.deepEqual(plan.changes.map((c) => c.path).sort(), [...GUARD_FILES, 'manifest.json'].map((f) => `${GUARD_REL}/${f}`).concat(['.claude/settings.json', '.gitignore', 'flowrail/config.json', 'flowrail/red-lines.json']).sort());
    const lines = JSON.parse(plan.changes.find((c) => c.path === 'flowrail/red-lines.json').after);
    assert.deepEqual(lines.map((l) => l.id), STARTERS);
    assert.ok(lines.every((l) => l.hook.builtin), 'starter red lines use builtins');
    apply(root, plan.changes);
    if (withPkg) assert.equal(read(root, 'package.json'), '{"name":"x"}', 'package.json is never touched');
    assert.ok(!fs.existsSync(path.join(root, 'node_modules')));
  }
  const noMcp = planInit(tmpdir(), { minimal: true, mcp: false });
  assert.ok(!JSON.parse(noMcp.changes.find((c) => c.path === 'flowrail/red-lines.json').after).some((l) => l.id === 'ask-before-mcp-actions'));
});

test('flowrail guard init --yes from the CLI: no npm, no CLAUDE.md, guard live', () => {
  const root = tmpdir();
  const r = cli(root, 'guard', 'init', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /The guard is set up/);
  assert.ok(!fs.existsSync(path.join(root, 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(root, 'flowrail', 'board.json')));
  assert.equal(hooksStatus(paths(root)).healthy, true);
  assert.equal(cli(root, 'hooks', 'status').status, 0);
});

test('the vendored guard imports nothing outside its own folder', () => {
  for (const f of GUARD_FILES) {
    const src = fs.readFileSync(path.join(GUARD_SRC, f), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"\n]*from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const spec = m[1] || m[2];
      const own = spec.startsWith('.') && path.posix.join(path.posix.dirname(f), spec);
      assert.ok(spec.startsWith('node:') || GUARD_FILES.includes(own), `${f} imports ${spec}`);
    }
  }
});

test('the vendored guard is formatted for reading: no line over 100 columns', () => {
  for (const f of GUARD_FILES) {
    const long = fs.readFileSync(path.join(GUARD_SRC, f), 'utf8').split('\n')
      .map((l, i) => [i + 1, l.length]).filter(([, n]) => n > 100);
    assert.deepEqual(long, [], f);
  }
});

test('uninstall removes hooks, the block and the guard, keeps everything else', () => {
  const root = project();
  apply(root, planInit(root, { room: NO_FILES }).changes);
  apply(root, planUninstall(root).changes);
  assert.deepEqual(JSON.parse(read(root, '.claude/settings.json')), userSettings);
  assert.equal(read(root, 'CLAUDE.md'), '# Notes\n\n- Never push without asking.\n- Do not deploy without approval.\n');
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'flowrail')));
  assert.ok(fs.existsSync(path.join(root, 'flowrail', 'red-lines.json')));
  assert.deepEqual(planUninstall(root).changes, []);
});

test('withBlock replaces an existing block in place', () => {
  const once = withBlock('# A\n', claudeBlock());
  const twice = withBlock(once.replace('This project runs flowrail', 'OLD TEXT'), claudeBlock());
  assert.equal(twice, once);
  assert.equal(withoutBlock(once), '# A\n');
  assert.equal(withoutBlock(claudeBlock()), '');
});

test('upgrade moves an old npm-based setup (settings.local.json, npx --no-install) onto the vendored guard', () => {
  const root = project();
  apply(root, planInit(root, { room: NO_FILES }).changes);
  fs.rmSync(path.join(root, '.claude', 'flowrail'), { recursive: true });
  const old = (prefix) => ({ hooks: Object.fromEntries(['PreToolUse', 'SessionStart', 'SubagentStart', 'SubagentStop'].map((e) => [e, [{ hooks: [{ type: 'command', command: `${prefix} hook ${e === 'PreToolUse' ? 'pre-tool-use' : e === 'SessionStart' ? 'session-start' : 'subagent'}` }] }]])) });
  const oldHooks = old('npx --no-install flowrail').hooks;
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ ...userSettings, hooks: { ...userSettings.hooks, ...oldHooks, PreToolUse: [...userSettings.hooks.PreToolUse, ...oldHooks.PreToolUse] } }));
  fs.writeFileSync(path.join(root, '.claude', 'settings.local.json'), JSON.stringify(old('node "/nonexistent/flowrail/bin/flowrail.js"')));
  const before = hooksStatus(paths(root));
  assert.equal(before.healthy, false);
  apply(root, planUpgrade(root).changes);
  const s = JSON.parse(read(root, '.claude/settings.json'));
  assert.equal(s.hooks.PreToolUse.length, 2, 'the old flowrail hook is replaced, not duplicated');
  assert.equal(s.hooks.PreToolUse[1].hooks[0].command, hookCommand('pre-tool-use'));
  assert.ok(!fs.existsSync(path.join(root, '.claude', 'settings.local.json')), 'a file that only held flowrail hooks is removed');
  assert.equal(hooksStatus(paths(root)).healthy, true);
  assert.deepEqual(planUpgrade(root).changes, []);
});

test('a changed guard file means not enforced everywhere: status, red lines, CLI; upgrade restores it', () => {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  const p = paths(root);
  const hook = path.join(root, GUARD_REL, 'hook.mjs');
  fs.writeFileSync(hook, 'process.exit(0);\n' + fs.readFileSync(hook, 'utf8'));
  const hs = hooksStatus(p);
  assert.equal(hs.installed, true);
  assert.equal(hs.healthy, false);
  assert.deepEqual(hs.guard.changed, ['hook.mjs']);
  assert.match(hs.problem, /^Guard files changed \(hook\.mjs\)\. Run npx flowrail upgrade to restore/);
  assert.ok(describe(JSON.parse(read(root, 'flowrail/red-lines.json')), hs.healthy).every((l) => l.state === 'not-enforced'));
  assert.match(cli(root, 'redlines').stdout, /not enforced/);
  assert.doesNotMatch(cli(root, 'redlines').stdout, /\barmed\b/);
  assert.equal(cli(root, 'hooks', 'status').status, 1);
  const doc = cli(root, 'doctor');
  assert.equal(doc.status, 1);
  assert.match(doc.stdout, /Guard files changed \(hook\.mjs\)/);

  // Rewriting the manifest to match does not help: the package knows what it shipped.
  const m = JSON.parse(read(root, `${GUARD_REL}/manifest.json`));
  m.files['hook.mjs'] = sha256(fs.readFileSync(hook, 'utf8'));
  fs.writeFileSync(path.join(root, GUARD_REL, 'manifest.json'), JSON.stringify(m));
  assert.deepEqual(hooksStatus(p).guard.changed, ['hook.mjs']);
  // An extra module dropped next to the guard is flagged too.
  fs.writeFileSync(path.join(root, GUARD_REL, 'evil.js'), '');
  assert.ok(hooksStatus(p).guard.changed.includes('evil.js'));
  fs.rmSync(path.join(root, GUARD_REL, 'evil.js'));

  assert.equal(cli(root, 'upgrade', '--yes').status, 0);
  assert.equal(hooksStatus(p).healthy, true);
});

test('a guard from another flowrail version cannot be verified until upgrade', () => {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  const file = path.join(root, GUARD_REL, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), version: '0.0.1' }));
  const hs = hooksStatus(paths(root));
  assert.equal(hs.guard.verified, false);
  assert.match(hs.problem, /version 0\.0\.1/);
});

test('mergeHooks replaces old flowrail commands in place and leaves others alone', () => {
  const { settings, changed } = mergeHooks(userSettings);
  assert.equal(changed.length, 4);
  assert.equal(mergeHooks(settings).changed.length, 0);
});

test('init lists every rule with an honest verdict, reports skipped lines, writes the declared-only ones', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Rules\n\n- Never push without asking.\n- Never delete files in content/ without asking.\n- Do not edit .env\n- Never rm -rf outside the repo\n- Never run migrations against prod\n- Always run tests before commit\n- Use tabs.\n');
  const plan = planInit(root, { room: NO_FILES });
  assert.equal(plan.report.length, 6, 'the count is the list');
  assert.deepEqual(plan.report.map((r) => r.verdict), ['covered', 'not covered', 'partial', 'covered', 'not covered', 'not covered']);
  assert.equal(plan.report[4].lineId.startsWith('rule-'), true, 'migrations against prod is not claimed by protect-migrations');
  assert.deepEqual(plan.skipped, ['Use tabs']);
  assert.match(plan.report[2].detail, /Not held: /);
  apply(root, plan.changes);
  const lines = JSON.parse(read(root, 'flowrail/red-lines.json'));
  const stub = lines.find((l) => l.id === plan.report[1].lineId);
  assert.ok(stub, 'the not-covered rule is written');
  assert.equal(stub.hook, undefined);
  assert.equal(describe([stub], true)[0].state, 'declared');
  assert.deepEqual(planInit(root, { room: NO_FILES }).changes, [], 'and a second init changes nothing');
  const r = spawnSync(process.execPath, [BIN, 'init'], { cwd: tmpdir(), encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1' } });
  assert.match(r.stdout.split('\n')[1], /Non-interactive: showing the plan\. Re-run with --yes to apply\./);
});

test('a path rule becomes a protect-path red line when accepted', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), "- Don't delete anything in content/\n");
  const plan = planInit(root, { accept: ['protect-path-content'], room: NO_FILES });
  assert.equal(plan.report[0].verdict, 'covered');
  const line = JSON.parse(plan.changes.find((c) => c.path === 'flowrail/red-lines.json').after).find((l) => l.id === 'protect-path-content');
  assert.deepEqual(line.hook, { tool: '*', builtin: 'protect-path', params: { glob: 'content/**' } });
});

test('MCP servers are the project\'s: .mcp.json, its ~/.claude.json entry and settings (not user scope)', () => {
  const root = tmpdir();
  const home = tmpdir();
  fs.writeFileSync(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { github: {} } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { gmail: {} }, projects: { [root]: { mcpServers: { linear: {} } }, '/elsewhere': { mcpServers: { nope: {} } } } }));
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ enabledMcpjsonServers: ['slack'] }));
  assert.deepEqual(mcpServers(root, { home, env: {} }), ['github', 'linear', 'slack']);
  assert.deepEqual(mcpServers(tmpdir(), { home: tmpdir(), env: {} }), []);
});

test('the guard package is only the guard: status, config, help, doctor, re-init', () => {
  const root = tmpdir();
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: root, encoding: 'utf8', input: '', env: { ...process.env, NO_COLOR: '1' } });
  assert.equal(run('init', '--yes').status, 0);
  assert.deepEqual(JSON.parse(read(root, 'flowrail/config.json')), { name: path.basename(root), port: 4747 }, 'no dashboard modules or sprints');
  const st = run('status');
  assert.equal(st.status, 0, st.stdout);
  assert.match(st.stdout, /Guard +live \(/);
  assert.match(st.stdout, /Red lines +\d+ armed/);
  assert.match(st.stdout, /Rule changes +none outside flowrail/);
  assert.match(st.stdout, /This week +nothing held yet/);
  assert.doesNotMatch(st.stdout, /Sprint|Backlog|Routines/);
  const help = run('--help').stdout;
  assert.doesNotMatch(help, /CLAUDE\.md/);
  assert.match(help, /held = dangerous examples stopped; allowed = harmless examples let through; block = never runs; ask = Claude Code asks you first/);
  const doc = run('doctor').stdout;
  assert.doesNotMatch(doc, /Port \d+/);
  assert.match(doc, /fails closed/);
  // Re-init counts only the hooks that are not flowrail's own.
  assert.equal(detect(root).settings.hooks, 0);
  assert.match(run('init').stdout, /\.claude\/settings\.json with 0 hooks/);
  // An older hook command (runs hook.mjs unchecked) is not healthy until upgrade.
  const file = path.join(root, '.claude', 'settings.json');
  const s = JSON.parse(read(root, '.claude/settings.json'));
  s.hooks.PreToolUse.at(-1).hooks[0].command = 'node "$CLAUDE_PROJECT_DIR"/.claude/flowrail/guard/hook.mjs pre-tool-use';
  s.hooks.PreToolUse.at(-1).matcher = '*';
  fs.writeFileSync(file, JSON.stringify(s));
  assert.match(hooksStatus(paths(root)).problem, /do not verify the guard/);
  apply(root, planUpgrade(root).changes);
  const after = JSON.parse(read(root, '.claude/settings.json')).hooks.PreToolUse.at(-1);
  assert.equal(after.hooks[0].command, hookCommand('pre-tool-use'));
  assert.equal(after.matcher, 'Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|mcp__.*');
  assert.equal(hooksStatus(paths(root)).healthy, true);
});

test('init: what it prints is what it writes is what the hook does (wording, polarity, argv, MCP verbs)', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), [
    '- Never send an email without my OK',
    "- Don't create calendar events without asking",
    '- Always run `pnpm test` before committing',
    '- Never use `git commit --no-verify`',
    "- Don't touch config/prod.yaml",
    '- Never run `terraform destroy` ever',
    '- Do not delete anything in content/.',
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', private: true }));
  const r = cli(root, 'init', '--yes');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Enforce it as no-emails-without-signoff \(ask\)/, '"without my OK" asks, and says so');
  assert.match(r.stdout, /Enforce it as infra-destructive \(block\)/, '"never ... ever" blocks');
  assert.doesNotMatch(r.stdout, /Starters for what this project uses/, 'no repo evidence, no starters');
  assert.doesNotMatch(r.stdout, /cmd-pnpm-test/, 'an "always" rule is not held');
  assert.doesNotMatch(r.stdout, /Never delete, moving/);
  assert.match(r.stdout, /covered +"Don't create calendar events without asking"/);
  const lines = JSON.parse(read(root, 'flowrail/red-lines.json'));
  const get = (id) => lines.find((l) => l.id === id);
  assert.equal(get('no-emails-without-signoff').severity, 'ask');
  assert.equal(get('infra-destructive').severity, 'block');
  assert.equal(get('infra-destructive').title, 'Never destroy infrastructure');
  assert.deepEqual(get('cmd-git-commit-no-verify').hook, { tool: 'Bash', builtin: 'command', params: { argv: ['git', 'commit'], flags: ['--no-verify'] } });
  assert.deepEqual(get('protect-path-config-prod-yaml').hook.params, { glob: 'config/prod.yaml', edits: true });
  assert.equal(lines.filter((l) => l.hook && l.hook.builtin === 'publish-deploy').length, 0);
  assert.ok(!lines.some((l) => /pnpm-test/.test(l.id) && l.hook), 'no armed line for an "always" rule');
  const hook = (tool, input) => {
    const out = spawnSync(process.execPath, [path.join(root, GUARD_REL, 'hook.mjs'), 'pre-tool-use'], {
      input: JSON.stringify({ tool_name: tool, tool_input: input, cwd: root, session_id: 's' }), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    }).stdout;
    return out ? JSON.parse(out).hookSpecificOutput?.permissionDecision : 'allow';
  };
  const bash = (command) => hook('Bash', { command });
  assert.equal(bash('git commit -m fix --no-verify'), 'deny');
  assert.equal(bash('git commit -nm fix'), 'deny');
  assert.equal(bash('git commit -m fix'), 'allow');
  assert.equal(bash('pnpm test'), 'allow');
  assert.equal(bash('terraform destroy'), 'deny');
  assert.equal(bash("sed -i 's/a/b/' config/prod.yaml"), 'deny');
  assert.equal(bash('echo x >> config/prod.yaml'), 'deny');
  assert.equal(bash('cat config/prod.yaml'), 'allow');
  assert.equal(bash('sendmail a@example.invalid < m.txt'), 'ask');
  assert.equal(hook('mcp__claude_ai_Google_Calendar__create_event', { summary: 'x' }), 'ask');
  assert.equal(hook('Edit', { file_path: path.join(root, 'config/prod.yaml'), old_string: 'a', new_string: 'b' }), 'deny');
});

test('init: rules that name the same builtin become one line; globs are shown as written', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '- Never publish a release without asking\n- Do not deploy without approval\n- Never delete files in src/generated/**\n');
  const plan = planInit(root, { accept: ['no-publish-without-asking', 'no-deploy-without-asking', 'publish-deploy', 'protect-path-src-generated'] });
  const lines = JSON.parse(plan.changes.find((c) => c.path === 'flowrail/red-lines.json').after);
  assert.equal(lines.filter((l) => l.hook && l.hook.builtin === 'publish-deploy').length, 1);
  assert.ok(plan.report.every((r) => r.lineId.split(' + ').every((id) => lines.some((l) => l.id === id) || id.startsWith('settings:'))), 'every reported line is written');
  const gen = lines.find((l) => l.id === 'protect-path-src-generated');
  assert.equal(gen.hook.params.glob, 'src/generated/**');
  assert.match(gen.title, /src\/generated\/\*\*/);
});

test('init in a reused folder path starts a fresh journal epoch instead of reporting drift', () => {
  const { CLAUDECODE, ...human } = process.env;
  const cli = (root, ...a) => spawnSync(process.execPath, [BIN, ...a], { cwd: root, encoding: 'utf8', env: { ...human, NO_COLOR: '1' } });
  const root = tmpdir();
  assert.equal(cli(root, 'init', '--yes').status, 0);
  cli(root, 'redlines', 'test', 'git push');
  // The folder is deleted and another project is set up at the same path.
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '- Never force push\n');
  // Inside a Claude Code session init never starts an epoch (it could launder drift).
  assert.deepEqual(freshEpoch(root, { CLAUDECODE: '1' }), []);
  const r = cli(root, 'init', '--yes');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /moved aside/);
  assert.ok(fs.existsSync(path.join(root, '.flowrail')), 'init marks the folder as its own');
  const doctor = cli(root, 'doctor');
  assert.doesNotMatch(doctor.stdout, /changed outside flowrail|Audit log edited|missing from/);
  const st = cli(root, 'status');
  assert.match(st.stdout, /Rule changes +none outside flowrail/);
  // A second init in the same folder keeps the journal.
  const again = cli(root, 'init', '--yes');
  assert.doesNotMatch(again.stdout, /moved aside/);
});

test('redlines test and verify are dry runs: nothing lands in the log or the stats', () => {
  const root = tmpdir();
  assert.equal(cli(root, 'init', '--yes').status, 0);
  cli(root, 'redlines', 'test', 'git push --force');
  cli(root, 'redlines', 'verify');
  assert.ok(!fs.existsSync(path.join(root, '.flowrail', 'redlines.log')));
  assert.match(cli(root, 'status').stdout, /This week +nothing held yet/);
});
