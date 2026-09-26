// flowrail doctor | check | redlines
import fs from 'node:fs';
import path from 'node:path';
import { out, c, mark, json, confirm, printDiff, LEGEND, word } from './ui.js';
import { workspace } from './main.js';
import { findRoot, paths } from '../core/paths.js';
import * as doctorCore from '../core/doctor.js';
import {
  loadLines, validateLines, runChecks, decide, reasonFor, stats, describe, stateCounts, stateSummary,
  STATE_LABEL, logChange, workspaces, weakenings, driftStatus, acceptRules, readAccepted, watchedPath,
} from '../core/redlines.js';
import { verifyRedlines } from '../core/verify.js';
import { RECIPES, asRedLine, starterLines } from '../core/recipes.js';
import { hooksStatus, hooksSummary, cliName } from '../core/hooks.js';
import { portRange } from '../guard/builtins.js';
import { loadConfig } from '../core/workspace.js';
import { readJson, writeJson } from '../core/util.js';

export async function doctor(_pos, flags) {
  const root = findRoot(process.cwd());
  const checks = await doctorCore.run(root ? paths(root) : null);
  if (flags.json) return json(checks);
  for (const ch of checks) {
    out(`  ${mark[ch.status]} ${ch.title.padEnd(14)} ${c.dim(ch.detail)}`);
    if (ch.fix) out(`    ${mark.arrow} ${ch.status === 'fail' ? c.cyan(ch.fix) : c.dim(ch.fix)}`);
  }
  const fails = checks.filter((ch) => ch.status === 'fail').length;
  out(fails ? `\n${fails} to fix.` : `\n${mark.ok} All good.`);
  if (fails) process.exitCode = 1;
}

/** flowrail status: the guard only. Is it live, what does it hold, what did it hold this week. */
export function status(_pos, flags) {
  const p = workspace();
  const hs = hooksStatus(p);
  const lines = describe(loadLines(p), hs.healthy);
  const n = stateCounts(lines, hs.healthy);
  const st = stats(p);
  const d = driftStatus(p);
  if (flags.json) return json({ root: p.root, hooks: hooksSummary(hs), redlines: n, drift: d, held7d: st.held7d, byLine: st.byId });
  const top = Object.entries(st.byId).sort((a, b) => b[1] - a[1]).map(([id, k]) => `${k} ${id}`).join(', ');
  out(`${c.bold('flowrail guard')}  ${c.dim(p.root)}`);
  out(`  ${hs.healthy ? mark.ok : mark.fail} ${'Guard'.padEnd(13)} ${hs.healthy ? `live (${hs.guard.version}): every guard file matches its manifest; hooks in .claude/${hs.where}` : hs.problem}`);
  out(`  ${n.armed ? mark.ok : mark.warn} ${'Red lines'.padEnd(13)} ${stateSummary(n)}; protect-flowrail is built in and always on`);
  out(`  ${d.changed ? mark.fail : mark.ok} ${'Rule changes'.padEnd(13)} ${d.changed ? `${d.files.join(', ')} changed outside flowrail: every call asks until you run ${cliName()} redlines accept` : 'none outside flowrail'}`);
  out(`  ${mark.dot} ${'This week'.padEnd(13)} ${st.held7d ? `held ${st.held7d} call${st.held7d === 1 ? '' : 's'} (${top})` : 'nothing held yet'}`);
  if (!hs.healthy) {
    out(`\n${c.red('Not enforced.')} ${c.cyan(`${cliName()} ${hs.installed ? 'upgrade' : 'init'}`)}`);
    process.exitCode = 1;
  }
}

export function check(_pos, flags) {
  const root = findRoot(process.cwd());
  let p;
  let lines;
  if (root) {
    p = paths(root);
    lines = loadLines(p);
    const errors = validateLines(lines);
    if (errors.length) throw new Error(`flowrail/red-lines.json: ${errors.join('; ')}`);
  } else {
    p = paths(process.cwd());
    lines = starterLines();
    if (!flags.json) out(c.dim('No flowrail workspace here; checking with the starter red lines.'));
  }
  const withChecks = lines.filter((l) => l.check);
  const { results, files } = runChecks(p, lines);
  if (flags.json) return json({ results, files });
  if (!withChecks.length) return out(`No red line has a check yet. ${c.dim('Add "check": {"glob": "**/*.md", "pattern": "..."} to one.')}`);
  const blocks = results.filter((r) => r.severity === 'block');
  for (const l of withChecks) {
    const hits = results.filter((r) => r.id === l.id);
    const sym = !hits.length ? mark.ok : l.severity === 'block' ? mark.fail : mark.warn;
    out(`  ${sym} ${l.id}  ${c.dim(hits.length ? `${hits.length} hit${hits.length === 1 ? '' : 's'}` : 'clean')}`);
    for (const h of hits.slice(0, 20)) out(`      ${c.cyan(`${h.file}:${h.line}`)}  ${c.dim(h.text)}`);
    if (hits.length > 20) out(c.dim(`      ...and ${hits.length - 20} more`));
  }
  out(c.dim(`\n${files} files checked.`));
  if (blocks.length) {
    out(`${mark.fail} ${blocks.length} block-severity hit${blocks.length === 1 ? '' : 's'}.`);
    process.exitCode = 1;
  }
}

export async function redlines(pos, flags) {
  const sub = pos[0];
  if (sub === 'test') return test(pos.slice(1), flags);
  if (sub === 'add') return add(pos.slice(1), flags);
  if (sub === 'verify') return verifyCmd(flags);
  if (sub === 'accept') return accept(flags);
  const p = workspace();
  const hs = hooksStatus(p);
  const lines = describe(loadLines(p), hs.healthy);
  if (flags.json) return json(lines);
  const st = stats(p);
  if (!lines.length) return out(`No red lines yet. ${c.cyan(`${cliName()} redlines add --list`)}`);
  for (const l of lines) {
    const label = STATE_LABEL[l.state].padEnd(13);
    const state = l.state === 'armed' ? c.green(label) : l.state === 'not-enforced' ? c.red(label) : l.state === 'declared' ? c.yellow(label) : c.dim(label);
    const held = st.byId[l.id] ? c.dim(`  held ${st.byId[l.id]}× this week`) : '';
    out(`  ${state}  ${l.severity.padEnd(5)}  ${c.bold(l.id)}${l.floor ? c.dim('  built in, always on') : ''}${held}`);
    out(`                        ${l.summary}`);
  }
  const n = stateCounts(lines, hs.healthy);
  out(c.dim(`\n${stateSummary(n)}.${n.checked ? ' "Checked in CI" rules have no hook: flowrail check enforces them, not the runtime.' : ''}`));
  if (!hs.healthy) out(`\n${mark.warn} ${hs.problem}, so red lines with a hook are not enforced: ${c.cyan(`${cliName()} ${hs.installed ? 'upgrade' : 'init'}`)}`);
  if (st.probes7d) out(c.dim(`${st.probes7d} manual hook call${st.probes7d === 1 ? '' : 's'} this week (no Claude session), not counted as holds.`));
  const d = driftStatus(p);
  if (d.changed) out(`\n${mark.fail} Rules changed outside flowrail (${d.files.join(', ')}): every tool call asks until you run ${c.cyan(`${cliName()} redlines accept`)}.`);
  out(c.dim(LEGEND));
  out(c.dim(`\nTry one: flowrail redlines test "git push origin main"   Check them all: flowrail redlines verify`));
}

function test(pos, flags) {
  const subject = pos.join(' ');
  if (!subject) throw new Error('usage: flowrail redlines test "<bash command>" [--tool Write]');
  const tool = typeof flags.tool === 'string' ? flags.tool : 'Bash';
  const input = tool === 'Bash' ? { command: subject } : { file_path: subject };
  const found = findRoot(process.cwd());
  let r;
  if (found) {
    // A dry run: nothing is logged, so testing never counts as a hold.
    const p = paths(found);
    const { roots } = workspaces({ projectDir: p.root, cwd: process.cwd() });
    const all = roots.flatMap((x) => loadLines(paths(x)));
    r = decide(all, tool, input, { root: p.root, roots, cwd: process.cwd(), ports: portRange(loadConfig(p).port) });
  } else {
    const cwd = process.cwd();
    r = decide(starterLines(), tool, input, { root: cwd, roots: [cwd], cwd, ports: portRange(4747) });
  }
  if (flags.json) return json({ ...r, workspace: found || null });
  if (!found) out(c.dim(`No flowrail workspace here: testing against the starter red lines and the built-in floor (${cliName()} init sets up your own).`));
  if (tool === 'Bash') out(c.dim(`normalized: ${r.normalized.map((n) => JSON.stringify(n)).join(', ') || '(nothing)'}`));
  const label = { deny: c.red('held (block)'), ask: c.yellow('held (ask first)'), warn: c.yellow('warn'), allow: c.green('allowed') }[r.decision];
  out(`${label}${r.line ? `  ${reasonFor(r.line, r)}` : '  no red line matches'}`);
  out(c.dim(LEGEND));
}

/** Print a verify result as a table; returns it. Shared with init. */
export function printVerify(v, { all = false } = {}) {
  const w = Math.max(24, ...v.lines.map((l) => l.id.length));
  for (const l of v.lines) {
    const held = l.positive.filter((x) => x.ok).length;
    const allowed = l.negative.filter((x) => x.ok).length;
    const bad = l.positive.filter((x) => !x.ok);
    const loose = l.negative.filter((x) => !x.ok);
    const sym = bad.length ? mark.fail : loose.length ? mark.warn : mark.ok;
    out(`  ${sym} ${l.id.padEnd(w)}  held ${held}/${l.positive.length}   allowed ${allowed}/${l.negative.length}`);
    for (const x of bad) out(`      ${c.red('not held:')} ${x.probe}`);
    for (const x of loose) out(`      ${c.yellow(`also held (${word(x.decision)}):`)} ${x.probe}`);
    if (all) for (const x of [...l.positive, ...l.negative]) out(c.dim(`      ${word(x.decision).padEnd(5)} ${x.probe}`));
  }
  for (const s of v.skipped) out(c.dim(`  ${mark.dot} ${s.id.padEnd(w)}  not probed: ${s.why}`));
  const rules = v.lines.length;
  const summary = `Verified: ${rules} rule${rules === 1 ? '' : 's'}, ${v.held} probe${v.held === 1 ? '' : 's'} held, ${v.allowedAsExpected} allowed as expected.`;
  out(v.ok ? `${mark.ok} ${summary}` : `${mark.fail} ${summary} ${v.failed} probe${v.failed === 1 ? '' : 's'} NOT held.`);
  out(c.dim(LEGEND));
  return v;
}

function verifyCmd(flags) {
  const found = findRoot(process.cwd());
  const v = found ? verifyRedlines(paths(found)) : verifyRedlines(null, { lines: starterLines() });
  if (flags.json) {
    json(v);
  } else {
    if (!found) out(c.dim('No flowrail workspace here: verifying the starter red lines and the built-in floor.'));
    printVerify(v, { all: !!flags.all });
  }
  if (!v.ok) process.exitCode = 1;
}

/**
 * flowrail redlines accept: the human reviews red-lines.json / config.json changes made outside
 * flowrail, and accepts them. Only from a terminal, never from inside a Claude Code session.
 */
async function accept(flags) {
  const p = workspace();
  const d = driftStatus(p);
  if (!d.changed) return out(`${mark.ok} red-lines.json and config.json match what flowrail last accepted. Nothing to review.`);
  if (process.env.CLAUDECODE) {
    out(`${mark.fail} Refusing inside a Claude Code session (CLAUDECODE is set). Run it in your own terminal: ${c.cyan(`${cliName()} redlines accept`)}`);
    process.exitCode = 1;
    return;
  }
  if (!process.stdin.isTTY) {
    out(`${mark.fail} Not an interactive terminal. Review the change yourself: run ${c.cyan(`${cliName()} redlines accept`)} in a terminal.`);
    process.exitCode = 1;
    return;
  }
  const accepted = readAccepted(p.root);
  for (const file of d.files) {
    const name = path.posix.basename(file);
    const before = accepted[name] && accepted[name].text;
    let after = '';
    try { after = fs.readFileSync(watchedPath(p.root, name), 'utf8'); } catch { after = ''; }
    out(`\n${c.bold(`${file} changed outside flowrail`)}  ${c.dim(`(last accepted ${accepted[name] ? accepted[name].at : 'never'}${accepted[name] ? ` by ${accepted[name].by}` : ''})`)}`);
    if (typeof before === 'string') printDiff(before, after);
    else out(c.dim('    (no copy of the accepted version to compare with; showing nothing)'));
    if (name === 'red-lines.json') {
      let was = [];
      let now = [];
      try { was = JSON.parse(before || '[]'); now = JSON.parse(after || '[]'); } catch { /* shown as a diff */ }
      const weaker = weakenings(was, now);
      if (weaker.length) out(`    ${mark.warn} ${c.yellow(`This weakens the red lines: ${weaker.join('; ')}`)}`);
    }
  }
  const ok = await confirm('\nAccept these changes as the red lines flowrail enforces?', false);
  if (!ok) return out('Nothing accepted. Every tool call keeps asking until you accept or restore the files.');
  acceptRules(p.root, 'accepted by hand (flowrail redlines accept)');
  out(`${mark.ok} Accepted. The guard enforces the current files again.`);
}

function add(pos, flags) {
  if (flags.list || !pos[0]) {
    out(c.bold('Red-line recipes'));
    for (const r of RECIPES) out(`  ${c.cyan(r.id.padEnd(28))} ${r.severity.padEnd(5)}  ${r.title}`);
    out(c.dim('\nAdd one: flowrail redlines add no-deploy-without-asking   (or a path to a .json file)'));
    return;
  }
  const p = workspace();
  let line;
  const recipe = RECIPES.find((r) => r.id === pos[0]);
  if (recipe && recipe.id === 'protect-path') {
    // flowrail redlines add protect-path --glob "content/**"
    const glob = typeof flags.glob === 'string' ? flags.glob : null;
    if (!glob) throw new Error('usage: flowrail redlines add protect-path --glob "content/**"');
    const slug = glob.replace(/\*+/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'files';
    line = { ...asRedLine(recipe), id: `protect-path-${slug}`, title: `Ask before deleting, moving or overwriting files in ${glob}`, hook: { ...recipe.hook, params: { glob } } };
  } else if (recipe) line = asRedLine(recipe);
  else if (fs.existsSync(pos[0])) line = readJson(path.resolve(pos[0]));
  else throw new Error(`no recipe or file "${pos[0]}". See: flowrail redlines add --list`);
  const lines = loadLines(p);
  if (lines.some((l) => l.id === line.id)) return out(`${mark.ok} ${line.id} is already a red line.`);
  const next = [...lines, line];
  const errors = validateLines(next);
  if (errors.length) throw new Error(errors.join('; '));
  writeJson(p.redlines, next);
  logChange(p, lines, next, 'cli');
  out(`${mark.ok} Added ${c.bold(line.id)} (${line.severity}) to flowrail/red-lines.json.`);
}
