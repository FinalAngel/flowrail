// flowrail init | guard init | upgrade | uninstall | hooks
import path from 'node:path';
import { out, c, mark, confirm, printDiff } from './ui.js';
import { detect, planInit, planUpgrade, planUninstall, planHooks, planUnhooks, proposals, apply, ruleReport, freshEpoch } from '../core/init.js';
import { findRoot, paths } from '../core/paths.js';
import { loadLines, stateCounts, stateSummary } from '../core/redlines.js';
import { hooksStatus, GUARD_REL } from '../core/hooks.js';
import { workspace } from './main.js';
import { printVerify } from './safety.js';
import { verifyRedlines } from '../core/verify.js';
import { RECIPES, asRedLine, recipeSeverity } from '../core/recipes.js';
import { summaryOf } from '../core/redlines.js';

const CLI = 'npx flowrail';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeFound(f) {
  const bits = [];
  bits.push(f.git ? `git repo${f.branch ? ` (${f.branch})` : ''}` : 'no git repo');
  if (f.claudeMd.exists) bits.push(`CLAUDE.md with ${plural(f.claudeMd.rules.length, 'rule')}`);
  if (f.agentsMd.exists) bits.push(`AGENTS.md with ${plural(f.agentsMd.rules.length, 'rule')}`);
  if (f.agents) bits.push(`${plural(f.agents, 'agent')} in .claude/agents`);
  if (f.skills) bits.push(plural(f.skills, 'skill'));
  if (f.commands) bits.push(plural(f.commands, 'command'));
  if (f.settings.exists) bits.push(f.settings.valid ? `.claude/settings.json with ${plural(f.settings.hooks, 'hook')}` : '.claude/settings.json (not valid JSON)');
  if (f.workspace) bits.push('flowrail workspace (already set up)');
  return bits.join(', ');
}

/** Print a plan. flowrail-internal files are listed (the guard as one line); anything else gets a diff. */
function printPlan(changes, flags = {}) {
  const guard = changes.filter((ch) => ch.path.startsWith(GUARD_REL + '/'));
  const internal = changes.filter((ch) => ch.internal && !guard.includes(ch));
  const external = changes.filter((ch) => !ch.internal);
  if (guard.length) {
    const removing = guard.every((ch) => ch.kind === 'remove');
    out(`\n${c.bold(removing ? 'Will remove' : guard.some((ch) => ch.kind === 'change') ? 'Will restore' : 'Will add')} ${GUARD_REL}/  ${c.dim(`(the guard: ${guard.map((ch) => ch.path.slice(GUARD_REL.length + 1)).join(', ')}; plain Node, no dependencies, commit it)`)}`);
  }
  if (internal.length) {
    out(`\n${c.bold('Will add')}  ${c.dim('(inside flowrail/, yours to edit or delete)')}`);
    for (const ch of internal) out(`  ${c.green(ch.kind === 'add' ? '+' : ch.kind === 'remove' ? '-' : '~')} ${ch.path}`);
  }
  for (const ch of external) {
    const verb = ch.kind === 'add' ? 'Will create' : ch.kind === 'remove' ? 'Will remove' : 'Will change';
    out(`\n${c.bold(verb)} ${ch.path}${ch.summary ? c.dim(`  (${ch.summary})`) : ''}`);
    if (ch.lines && !flags.diff) for (const l of ch.lines) out(`    ${l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l)}`);
    else if (ch.kind !== 'remove') printDiff(ch.before, ch.after);
  }
}

async function confirmAndApply(root, plan, flags, question = 'Apply these changes?') {
  if (!flags.yes) {
    out('');
    const ok = await confirm(question);
    if (ok === null) {
      out(`${mark.warn} Not an interactive terminal, so nothing was changed. Re-run with ${c.cyan('--yes')} to apply.`);
      process.exitCode = 2;
      return false;
    }
    if (!ok) { out('Nothing changed.'); return false; }
  }
  return apply(root, plan.changes);
}

const VERDICT = { covered: (t) => c.green(t), partial: (t) => c.yellow(t), 'not covered': (t) => c.red(t) };

/** Every rule found, with what holds it, and every list item skipped because it is not a rule. */
function printReport(report, skipped) {
  if (report.length) {
    out(`\n${c.bold(`Rules in your own files (${report.length})`)}`);
    for (const r of report) {
      out(`  ${VERDICT[r.verdict](r.verdict.padEnd(11))}  "${r.quote}"  ${c.dim(r.source)}`);
      out(`  ${' '.repeat(11)}  ${c.dim(`${r.lineId}: ${r.detail}`)}`);
    }
  }
  if (skipped.length) out(c.dim(`  Skipped ${plural(skipped.length, 'line')} that ${skipped.length === 1 ? "isn't a rule" : "aren't rules"}: ${skipped.slice(0, 5).map((s) => `"${s}"`).join(', ')}${skipped.length > 5 ? ', ...' : ''}`));
}

function reportCounts(report) {
  const n = (v) => report.filter((r) => r.verdict === v).length;
  return `${plural(report.length, 'rule')} in your files: ${n('covered')} covered, ${n('partial')} partial, ${n('not covered')} not covered (declared only)`;
}

/** `flowrail guard init`: the guard alone. `flowrail guard` with no subcommand is the hook (see bin). */
export async function guard(pos, flags) {
  if (pos[0] !== 'init') throw new Error('usage: flowrail guard init [--yes]   (the guard only: red lines and hooks, no dashboard files)');
  return init([], flags);
}

/** The guard init. The control room passes `room` (its files, see planInit) for the full init. */
export async function init(_pos, flags, room) {
  const root = process.cwd();
  const found = detect(root);
  const interactive = !!process.stdin.isTTY && !flags.yes;
  const guardOnly = !room;
  out(`${c.bold(guardOnly ? 'flowrail guard init' : 'flowrail init')}  ${c.dim(root)}`);
  if (!flags.yes && !process.stdin.isTTY) out(`${mark.warn} Non-interactive: showing the plan. Re-run with ${c.cyan('--yes')} to apply.`);
  const parent = !found.workspace && findRoot(path.dirname(root));
  if (parent) out(`${mark.warn} ${c.dim(`A workspace already exists in ${parent}. This creates a separate one here; the guard applies the red lines of both.`)}`);
  out(`\n${c.bold('Found')}  ${describeFound(found)}`);

  let mcp = true;
  if (found.mcp.length) {
    const q = `\n${c.bold('MCP servers')}  ${found.mcp.join(', ')}. Ask before their send, post, push, merge, delete and pay tools?`;
    const ans = interactive ? await confirm(q) : true;
    if (!interactive) out(`${q} ${c.dim('yes')}`);
    mcp = ans !== false;
  }

  const accept = [];
  let existing = new Set();
  let yourBuiltins = new Set();
  try {
    const mine = loadLines(paths(root));
    existing = new Set(mine.map((l) => l.id));
    yourBuiltins = new Set(mine.map((l) => l.hook?.builtin).filter(Boolean));
  } catch { /* invalid JSON is reported by the plan */ }
  // A recipe whose builtin a line of yours already runs is not offered: your line and its severity win.
  const props = proposals(found).filter((pr) => !pr.starter && !existing.has(pr.recipe.id)
    && !yourBuiltins.has(pr.recipe.hook?.builtin));
  if (props.length) out(`\n${c.bold('Recipes that match your rules')}`);
  for (const pr of props) {
    const q = `  You wrote "${pr.quote}". Enforce it as ${c.cyan(pr.recipe.id)} (${recipeSeverity(pr.recipe, pr.rule || pr.quote)})?`;
    const ans = interactive ? await confirm(q) : true;
    if (!interactive) out(`${q} ${c.dim('yes')}`);
    if (ans !== false) accept.push(pr.recipe.id);
  }

  // Project-aware starters: offered from what this project uses (scripts, CI, files, PATH, MCP).
  // A starter whose builtin a line already runs (no-publish-without-asking runs publish-deploy) is
  // not offered again.
  const builtinOf = (id) => RECIPES.find((r) => r.id === id)?.hook.builtin;
  const armed = new Set([...existing, ...accept].map(builtinOf).filter(Boolean));
  const offers = found.tooling.filter((t) => !existing.has(t.recipe) && !accept.includes(t.recipe)
    && !armed.has(builtinOf(t.recipe))
    && (mcp || !['no-emails-without-signoff', 'no-payments'].includes(t.recipe)));
  if (offers.length) out(`\n${c.bold('Starters for what this project uses')}`);
  for (const t of offers) {
    const recipe = RECIPES.find((r) => r.id === t.recipe);
    if (!recipe) continue;
    const q = `  Found ${t.evidence.slice(0, 3).join(', ')}. Add ${c.cyan(recipe.id)} (${recipe.severity}): ${summaryOf(asRedLine(recipe))}?`;
    const ans = interactive ? await confirm(q) : true;
    if (!interactive) out(`${q} ${c.dim('yes')}`);
    if (ans !== false) accept.push(recipe.id);
  }

  // Commands and paths a rule quotes that no chosen recipe holds: offer a red line for exactly that.
  const decline = [];
  const extra = ruleReport(found, { accept, existing, mcp }).flatMap((r) => (r.generated || []).map((l) => ({ l, quote: r.quote }))).filter(({ l }) => !existing.has(l.id));
  if (extra.length) out(`\n${c.bold('Red lines for what your rules quote')}`);
  for (const { l, quote } of extra) {
    const q = `  You wrote "${quote}". Add ${c.cyan(l.id)} (${l.severity}): ${l.title}?`;
    const ans = interactive ? await confirm(q) : true;
    if (!interactive) out(`${q} ${c.dim('yes')}`);
    if (ans === false) decline.push(l.id);
  }

  const plan = planInit(root, { room, agentsMd: !!flags['agents-md'], accept, mcp, decline });
  printReport(plan.report, plan.skipped);
  for (const pb of plan.problems) out(`${mark.warn} ${pb}`);
  if (!plan.changes.length) {
    if (flags.yes || interactive) reportEpoch(freshEpoch(root));
    out(`\n${mark.ok} Already set up. Nothing to change.`);
    printNext(guardOnly);
    return;
  }
  printPlan(plan.changes, flags);
  const applied = await confirmAndApply(root, plan, flags);
  if (!applied) return;
  reportEpoch(applied.epoch);

  const p = paths(root);
  const n = stateCounts(loadLines(p), hooksStatus(p).healthy);
  out(`\n${mark.ok} ${c.bold(guardOnly ? 'The guard is set up.' : 'flowrail is set up.')} Red lines: ${stateSummary(n)}; protect-flowrail is built in and always on.`);
  if (plan.report.length) out(`  ${reportCounts(plan.report)}.`);
  out(c.dim(`  Commit ${GUARD_REL}/, flowrail/red-lines.json and .claude/settings.json: everyone who clones gets the guard, no npm install needed.`));
  // "Covered" is checked, not claimed: every red line against calls it must hold and allow.
  out(`\n${c.bold('Verify')}  ${c.dim('every red line against calls it must hold and calls it must allow')}`);
  const v = printVerify(verifyRedlines(p));
  if (!v.ok) process.exitCode = 1;
  await offerAudit(root, interactive);
  printNext(guardOnly);
}

/** A reused folder path: say that its old machine-local history was moved aside. */
function reportEpoch(moved) {
  if (moved.length) out(c.dim(`\n  This folder has no .flowrail/ but this machine has flowrail history for its path (a deleted project or an old clone): that journal and its accepted rules were moved aside (${moved.map((f) => path.basename(f)).join(', ')}) and a fresh journal started.`));
}

/** "What would these rules have caught in your last 30 days?" Read-only, local, no model. */
async function offerAudit(root, interactive) {
  let mod;
  try { mod = { ...(await import('../core/audit.js')), ...(await import('./audit.js')) }; } catch { return; }
  if (interactive) {
    const ans = await confirm('\nSee what these red lines would have caught in your last 30 days of Claude Code sessions? (read-only, nothing leaves this machine)');
    if (ans === false || ans === null) return;
  } else out('');
  try { mod.printAudit(mod.auditSummary(root, { days: 30 }), { limit: 8 }); } catch (e) { out(c.dim(`(audit skipped: ${e.message})`)); }
}

function printNext(guardOnly) {
  const w = 22;
  out(`\n${c.bold('Next')}`);
  out(`  ${c.cyan('claude'.padEnd(w))} ask it to "git push". The red line holds it and it asks you instead.`);
  out(`  ${c.cyan(`${CLI} redlines`.padEnd(w))} what is armed, in plain English`);
  if (!guardOnly) out(`  ${c.cyan('npx @finalangel/flowrail-room'.padEnd(w))} dashboard on http://127.0.0.1:4747`);
  out(`  ${c.cyan(`${CLI} doctor`.padEnd(w))} if anything looks off`);
}

export async function upgrade(_pos, flags) {
  const p = workspace();
  const plan = planUpgrade(p.root);
  for (const pb of plan.problems) out(`${mark.warn} ${pb}`);
  if (!plan.changes.length) return out(`${mark.ok} Up to date: ${c.dim(plan.note)}.`);
  printPlan(plan.changes, flags);
  if (await confirmAndApply(p.root, plan, flags)) out(`\n${mark.ok} Upgraded: ${c.dim(plan.note)}. Restart any running Claude Code session.`);
}

export async function uninstall(_pos, flags) {
  const root = findRoot(process.cwd()) || process.cwd();
  const plan = planUninstall(root);
  for (const pb of plan.problems) out(`${mark.warn} ${pb}`);
  if (!plan.changes.length) {
    out(`${mark.ok} No flowrail hooks, guard or CLAUDE.md block to remove.`);
  } else {
    printPlan(plan.changes, flags);
    if (!(await confirmAndApply(root, plan, flags, 'Remove them?'))) return;
    out(`\n${mark.ok} The guard, its hooks and the CLAUDE.md block are gone.`);
  }
  out(c.dim('Your data in flowrail/ and .flowrail/ is untouched. Delete those folders yourself if you want it gone too.'));
  out(c.dim(`Scheduled routines, if any: ${CLI} routines uninstall`));
}

export async function hooks(pos, flags) {
  const p = workspace();
  const sub = pos[0] || 'status';
  if (sub === 'status') {
    const hs = hooksStatus(p);
    for (const e of ['PreToolUse', 'SessionStart', 'SubagentStart', 'SubagentStop']) out(`  ${hs.events[e] ? mark.ok : mark.fail} ${e}`);
    out(`  ${hs.guard.verified ? mark.ok : mark.fail} Guard files ${hs.guard.verified ? `verified (${hs.guard.version})` : hs.guard.changed.length ? `changed: ${hs.guard.changed.join(', ')}` : 'not verified'}`);
    if (hs.where) out(c.dim(`  in .claude/${hs.where}: ${hs.command}`));
    out(hs.healthy ? `\n${c.green('Guard live.')}` : `\n${c.red('Not enforced.')} ${hs.problem}.`);
    if (!hs.healthy) process.exitCode = 1;
    return;
  }
  if (sub !== 'install' && sub !== 'uninstall') throw new Error('usage: flowrail hooks install|uninstall|status');
  const r = sub === 'install' ? { changes: [...planUpgrade(p.root).changes.filter((ch) => !/^(CLAUDE|AGENTS)\.md$/.test(ch.path))], error: planHooks(p.root).error } : planUnhooks(p.root);
  if (r.error) throw new Error(r.error);
  if (!r.changes.length) return out(`${mark.ok} ${sub === 'install' ? 'The guard and its hooks are already installed.' : 'No flowrail hooks to remove.'}`);
  printPlan(r.changes, flags);
  if (await confirmAndApply(p.root, { changes: r.changes }, flags)) out(`\n${mark.ok} ${sub === 'install' ? 'Guard installed. Restart any running Claude Code session.' : 'Hooks removed.'}`);
}
