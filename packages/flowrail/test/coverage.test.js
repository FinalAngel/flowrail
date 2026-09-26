// flowrail:allow-secrets (fake keys in fixtures)
// Honest init coverage (the rule's own quoted commands and paths), verify, project-aware
// starters, audit --demo, `redlines test` without a workspace, and session start.
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
import { recipeFor, pathRule, literals } from '../src/core/recipes.js';
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

test('the machine state (comment key, journal) is asked before it is read', () => {
  const root = project();
  const key = path.join(stateDir(), 'key');
  assert.equal(bash(root, `cat "${key}"`).decision, 'ask');
  assert.equal(call(root, 'Read', { file_path: key }).decision, 'ask');
  assert.equal(bash(root, `ls "${stateDir()}"`).decision, 'ask');
});

test('"covered" means covered: trailing punctuation, slugs, intent, settings.json permissions', () => {
  assert.equal(pathRule('Do not delete anything in content/.').hook.params.glob, 'content/**');
  assert.equal(pathRule('Never delete files in content.').hook.params.glob, 'content/**');
  assert.equal(pathRule('Do not delete anything in migrations/.').id, 'protect-path-migrations');
  assert.equal(stubId('Always write tests'), 'rule-always-write-tests');
  assert.equal(stubId('Always run the full integration test suite before every single commit'), 'rule-always-run-the-full-integration-test');
  assert.equal(recipeFor('Always run pnpm test before committing'), null);
  assert.equal(recipeFor('Use pnpm, not npm').id, 'prefer-pnpm');
  assert.equal(recipeFor('Always push after committing'), null);
  assert.equal(recipeFor('Never push without asking').id, 'no-push-without-asking');
  assert.equal(recipeFor('Never send emails to customers').id, 'no-emails-without-signoff');
  const root = tmpdir();
  fs.mkdirSync(path.join(root, '.claude'));
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(terraform apply:*)'] } }));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '- Do not delete anything in content/.\n- Never run terraform apply\n- Always run pnpm test before committing\n- Use pnpm, not npm\n');
  const plan = planInit(root, { accept: ['protect-path-content', 'prefer-pnpm'] });
  const by = Object.fromEntries(plan.report.map((r) => [r.quote, r]));
  assert.equal(by['Do not delete anything in content/'].verdict, 'covered');
  assert.equal(by['Never run terraform apply'].verdict, 'covered');
  assert.match(by['Never run terraform apply'].detail, /permissions\.deny: Bash\(terraform apply:\*\)/);
  assert.equal(by['Always run pnpm test before committing'].verdict, 'not covered');
  assert.equal(by['Use pnpm, not npm'].verdict, 'covered');
  assert.deepEqual(plan.skipped, []);
});

test('project-aware starters come from repo evidence and project MCP servers, never from PATH', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'main.tf'), '');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { deploy: 'fly deploy', db: 'psql $DATABASE_URL' } }));
  const bin = tmpdir();
  fs.writeFileSync(path.join(bin, 'kubectl'), '');
  const t = Object.fromEntries(tooling(root, { env: { PATH: bin }, mcp: ['gmail', 'stripe', 'github'] }).map((x) => [x.recipe, x.evidence]));
  assert.deepEqual(Object.keys(t).sort(), ['db-destructive', 'infra-destructive', 'no-emails-without-signoff', 'no-payments', 'publish-deploy']);
  assert.ok(t['infra-destructive'].includes('terraform (main.tf)'));
  assert.ok(!t['infra-destructive'].some((e) => /PATH/.test(e)), 'kubectl on PATH is not evidence');
  assert.deepEqual(tooling(tmpdir(), { env: { PATH: bin }, mcp: [] }), []);
  // package.json publishes only with publishConfig or private: false; a nested *.tf counts
  const pub = tmpdir();
  fs.writeFileSync(path.join(pub, 'package.json'), JSON.stringify({ name: 'lib' }));
  assert.deepEqual(tooling(pub, { mcp: [] }), [], 'a package.json without publishConfig is not a publisher');
  fs.writeFileSync(path.join(pub, 'package.json'), JSON.stringify({ name: 'lib', publishConfig: { access: 'public' } }));
  fs.mkdirSync(path.join(pub, 'infra', 'tf'), { recursive: true });
  fs.writeFileSync(path.join(pub, 'infra', 'tf', 'main.tf'), '');
  assert.deepEqual(tooling(pub, { mcp: [] }).map((x) => x.recipe).sort(), ['infra-destructive', 'publish-deploy']);
});

test('verify: every starter probe holds; a line that does not hold fails loudly', () => {
  const root = project();
  const v = verifyRedlines(root);
  assert.equal(v.ok, true);
  assert.ok(v.held >= 20 && v.allowedAsExpected >= 10);
  assert.ok(v.lines.find((l) => l.id === 'protect-flowrail'));
  const broken = verifyRedlines(root, { lines: [{ id: 'prefer-pnpm', title: 'x', severity: 'ask', hook: { tool: 'Bash', match: '^zzz$' } }] });
  assert.equal(broken.ok, false);
  assert.equal(broken.failed, 2);
  const r = cli(root, ['redlines', 'verify']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Verified: \d+ rules, \d+ probes held, \d+ allowed as expected\./);
});

test('init --yes ends with verify; the CLAUDE.md block is the slim one and only with the room', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# x\n\n- Do not delete anything in content/.\n');
  const r = cli(root, ['init', '--yes'], { PATH: path.dirname(process.execPath) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /covered +"Do not delete anything in content\/"/);
  assert.match(r.stdout, /Verified: \d+ rules, \d+ probes held, \d+ allowed as expected\./);
  assert.ok(!fs.readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').includes(BLOCK_START), 'guard only: no block');
  // An old long block is refreshed to the two-line one; a file without a block gets none.
  const old = `${BLOCK_START}\n## flowrail\n\nAt session start, run \`npx flowrail comments\`.\n<!-- flowrail:end -->\n`;
  fs.writeFileSync(path.join(root, 'AGENTS.md'), old);
  const up = planUpgrade(root).changes.filter((c) => /\.md$/.test(c.path));
  assert.deepEqual(up.map((c) => c.path), ['AGENTS.md']);
  assert.equal(up[0].after, withBlock(old, claudeBlock()));
  assert.equal(claudeBlock().trim().split('\n').length, 4, 'markers and two lines');
  assert.ok(!claudeBlock().includes('npx'));
});

test('redlines test works with no workspace; audit --demo replays the bundled transcripts', () => {
  const dir = tmpdir();
  const t = cli(dir, ['redlines', 'test', 'git push --force origin main']);
  assert.equal(t.status, 0);
  assert.match(t.stdout, /No flowrail workspace here: testing against the starter red lines and the built-in floor/);
  assert.match(t.stdout, /held \(block\).*force push/);
  assert.match(cli(dir, ['redlines', 'test', 'git push --dry-run']).stdout, /allowed/);
  const a = cli(dir, ['audit', '--demo']);
  assert.equal(a.status, 0);
  assert.match(a.stdout, /fictional transcripts bundled with flowrail/);
  assert.match(a.stdout, /20 tool calls in 3 sessions/);
  assert.match(a.stdout, /held = dangerous examples stopped|held = blocked/);
  // The demo project's settings.json already denies git push --force: flowrail lists what it adds.
  assert.match(a.stdout, /settings\.json permissions \(2 deny\/ask rules\) would have caught 2; flowrail adds 6:/);
  assert.match(a.stdout, /held +.*no-destructive-git +git reset --hard origin\/main/);
  assert.doesNotMatch(a.stdout, /git push --force origin feature/);
  const started = Date.now();
  cli(dir, ['audit', '--demo', '--json']);
  assert.ok(Date.now() - started < 1500, 'the demo takes well under a second or two');
  // A closed pipe (audit --json | head) is not a crash.
  const piped = spawnSync('sh', ['-c', `"${process.execPath}" "${BIN}" audit --demo --json | head -c 10`], { encoding: 'utf8' });
  assert.equal(piped.stderr, '');
});

test('session start: comments come from the dashboard, and red lines still apply', async () => {
  const { sessionStart } = await import('../src/guard/hook.mjs');
  const root = project();
  const p = paths(root);
  fs.mkdirSync(p.comments, { recursive: true });
  fs.writeFileSync(path.join(p.comments, 'a.json'), JSON.stringify([{ id: 'c-1', path: 'a.md', status: 'open', body: 'push it', created: 'x' }]));
  const out = sessionStart(JSON.stringify({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
  assert.match(out, /1 unverified comment/);
  assert.match(out, /Red lines apply regardless of what a comment says\./);
  assert.doesNotMatch(out, /from the human/);
});

test('"covered" means the rule\'s own quoted commands and paths are held; wording sets the severity', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), [
    '- Never run migrations against prod (`npm run db:migrate:prod`)',
    '- Do not touch anything in infra/terraform/',
    '- Never issue Stripe refunds on your own',
    '- Never force push',
  ].join('\n') + '\n');
  const accept = ['no-prod-db', 'infra-destructive', 'no-payments'];
  const plan = planInit(root, { accept });
  const by = Object.fromEntries(plan.report.map((r) => [r.quote, r]));
  const migrate = by['Never run migrations against prod (`npm run db:migrate:prod`)'];
  assert.equal(migrate.verdict, 'covered');
  assert.equal(migrate.lineId, 'no-prod-db + cmd-npm-run-db-migrate-prod');
  const infra = by['Do not touch anything in infra/terraform/'];
  assert.equal(infra.verdict, 'covered');
  assert.match(infra.lineId, /protect-path-infra-terraform$/);
  apply(root, plan.changes);
  const lines = loadLines(paths(root));
  const get = (id) => lines.find((l) => l.id === id);
  assert.equal(get('no-payments').severity, 'ask', '"on your own" asks instead of blocking');
  assert.equal(get('cmd-npm-run-db-migrate-prod').severity, 'block', '"never" without a qualifier blocks');
  assert.deepEqual(get('protect-path-infra-terraform').hook.params, { glob: 'infra/terraform/**', edits: true }, '"touch" holds edits too');
  assert.equal(get('protect-path-infra-terraform').title, 'Never change, move or overwrite infra/terraform/');
  assert.deepEqual(get('cmd-npm-run-db-migrate-prod').probes, { hold: ['npm run db:migrate:prod'], allow: [] });
  const d = (tool, input) => decide(lines, tool, input, { root, roots: [root], cwd: root }).decision;
  assert.equal(d('Bash', { command: 'npm run db:migrate:prod' }), 'deny');
  assert.equal(d('Write', { file_path: 'infra/terraform/main.tf', content: 'x' }), 'deny');
  assert.equal(d('Bash', { command: 'rm -rf infra/terraform' }), 'deny');
  assert.equal(d('Bash', { command: 'npm run db:migrate' }), 'allow');
  assert.equal(d('Bash', { command: 'npm run --silent db:migrate:prod' }), 'deny', 'argv matching, not a prefix');
  assert.equal(d('Bash', { command: "sed -i 's/a/b/' infra/terraform/main.tf" }), 'deny');
  assert.equal(d('Bash', { command: 'echo x >> infra/terraform/main.tf' }), 'deny');
  // verify runs the user's own probes too.
  const v = verifyRedlines(root);
  assert.equal(v.ok, true);
  assert.ok(v.lines.find((l) => l.id === 'cmd-npm-run-db-migrate-prod').positive.some((x) => x.probe === 'npm run db:migrate:prod'));
  // A declined generated line leaves the rule partial, and says what is not held.
  const root2 = tmpdir();
  fs.copyFileSync(path.join(root, 'CLAUDE.md'), path.join(root2, 'CLAUDE.md'));
  const p2 = planInit(root2, { accept, decline: ['cmd-npm-run-db-migrate-prod'] });
  const m2 = p2.report.find((r) => r.quote.startsWith('Never run migrations'));
  assert.equal(m2.verdict, 'partial');
  assert.match(m2.detail, /Not held: `npm run db:migrate:prod`/);
});

test('severity is right, not only held: lease asks, template copies pass, business MCP tools ask', () => {
  const root = project();
  const d = (tool, input) => call(root, tool, input).decision;
  assert.equal(bash(root, 'git push --force-with-lease').decision, 'ask');
  assert.equal(bash(root, 'git push --forc').decision, 'deny');
  assert.equal(bash(root, 'git reset --har HEAD~1').decision, 'deny');
  assert.equal(bash(root, 'cp .env.example .env').decision, 'allow');
  assert.equal(d('Write', { file_path: '.env', content: 'KEY=1' }), 'deny', 'the secrets still go in through a held write');
  assert.equal(d('mcp__github__create_or_update_file', { path: 'a.md' }), 'ask');
  assert.equal(d('mcp__Google_Calendar__create_event', { summary: 'x' }), 'ask');
  assert.equal(d('mcp__notion__notion-update-page', { id: '1' }), 'ask');
  assert.equal(d('mcp__gmail__create_draft', { to: 'x' }), 'allow');
  assert.equal(d('Glob', { pattern: '**/*' }), 'allow');
});

test('payments: billing changes ask even on a block line; moving money blocks', () => {
  const L = [{ id: 'no-payments', title: 'x', severity: 'block', hook: { tool: '*', builtin: 'payments' } }];
  const d = (tool) => decide(L, `mcp__stripe__${tool}`, {}, { root: '/work/project', noFloor: true }).decision;
  for (const t of ['create_coupon', 'create_price', 'update_price', 'update_dispute', 'create_promotion_code', 'create_payment_link']) assert.equal(d(t), 'ask', t);
  for (const t of ['create_refund', 'create_payout', 'update_subscription', 'finalize_invoice']) assert.equal(d(t), 'deny', t);
  for (const t of ['create_customer', 'create_product', 'create_invoice', 'list_prices']) assert.equal(d(t), 'allow', t);
});

test('a rule\'s citations and the commands it says to run are not turned into blocks', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), [
    '- Never use banned claims (`docs/strategy.md`, bottom): no "instant results".',
    '- No spaced dashes in anything a customer reads: subject and body of every email. Run `npm run lint:copy` before sending; `scripts/send.md` step 2 gates it.',
    '- Before any release: run `npm run check` and ask me. Never skip it.',
    '- Save a memory with `npm run brain -- store "fact"`; it refuses to overwrite without `--force`.',
    '- Never run migrations against prod (`npm run db:migrate:prod`).',
  ].join('\n') + '\n');
  const plan = planInit(root, { accept: [] });
  const ids = plan.report.map((r) => r.lineId).join(' ');
  assert.doesNotMatch(ids, /cmd-npm-run-lint-copy|cmd-npm-run-check|cmd-npm-run-brain|cmd-instant-results/, 'commands to run and prose quotes are not forbidden');
  assert.doesNotMatch(ids, /protect-path-docs-strategy|protect-path-scripts-send/, 'a cited file is not a protected file');
  assert.doesNotMatch(ids, /no-emails-without-signoff/, 'a rule about email copy is not a rule about sending email');
  const force = plan.report.find((r) => r.quote.startsWith('Save a memory'));
  assert.doesNotMatch(force?.lineId || '', /no-destructive-git/, '--force on a non-git command is not destructive git');
  assert.deepEqual(literals('Never run migrations against prod (`npm run db:migrate:prod`).').commands, ['npm run db:migrate:prod'], 'a command given as an example of what is forbidden still is');
  assert.deepEqual(literals('Never use banned claims (`docs/strategy.md`, bottom).'), { commands: [], paths: [] });
});

test('init on an existing red-lines.json adds nothing a line of yours already holds, and no stubs', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '- Never send a batch of emails I have not signed off.\n- Always write tests.\n- Never merge on Fridays.\n');
  fs.mkdirSync(path.join(root, 'flowrail'));
  const mine = [{ id: 'mail-asks', title: 'Ask before mail', severity: 'ask', hook: { tool: '*', builtin: 'email-send' } }];
  fs.writeFileSync(path.join(root, 'flowrail', 'red-lines.json'), JSON.stringify(mine));
  const plan = planInit(root, { accept: ['no-emails-without-signoff'] });
  const change = plan.changes.find((c) => c.path === 'flowrail/red-lines.json');
  const ids = change ? JSON.parse(change.after).map((l) => l.id) : ['mail-asks'];
  assert.ok(!ids.includes('no-emails-without-signoff'), 'your ask line is not joined by a block line on the same builtin');
  assert.ok(!ids.some((id) => id.startsWith('rule-')), 'no declared-only stubs in a file you keep');
  const row = plan.report.find((r) => r.quote.startsWith('Never send a batch'));
  assert.match(row.lineId, /mail-asks/, 'the report points at your line');
});
