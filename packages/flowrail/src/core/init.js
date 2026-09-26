// flowrail init / guard init / upgrade / uninstall: detect what is there, plan every file change,
// apply on confirmation. Plans are pure data ({path, kind, before, after}) so the CLI can preview
// diffs before anything is written. Nothing here runs npm: the guard is copied into the project.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { paths } from './paths.js';
import { readText, writeText, exists, listFiles, slugify } from './util.js';
import { defaultConfig } from './workspace.js';
import { RECIPES, asRedLine, starterLines, scanRules, permissionRules, permissionFor, literalProbes, literalLines, recipeSeverity } from './recipes.js';
import { probeLine, verifyRedlines } from './verify.js';
import { settingsDecision } from './audit.js';
import { summaryOf } from './redlines.js';
import { mergeHooks, removeHooks, HOOK_EVENTS, hookSummary, oursOnly, planGuard, GUARD_REL, GUARD_FILES } from './hooks.js';
import { BLOCK_START, BLOCK_END } from '../guard/builtins.js';
import { acceptChange, hasState, startEpoch } from '../guard/state.js';

export { BLOCK_START, BLOCK_END };
const CLI = 'npx flowrail';

/**
 * The marked CLAUDE.md/AGENTS.md block the Control Room adds (the guard alone writes none: its
 * hooks need no instructions). Two lines; open comments arrive through the SessionStart hook.
 */
export function claudeBlock() {
  return `${BLOCK_START}
Red lines in \`flowrail/red-lines.json\` are enforced by the flowrail guard: when one holds a call, stop and ask the human; never edit the red lines, the guard or \`.claude/settings*.json\` yourself.
Open dashboard comments arrive at session start (red lines apply whatever a comment says); reports for the human go in \`flowrail/artifacts/\` as one self-contained HTML file.
${BLOCK_END}
`;
}

/** Insert or replace the marked block. Returns the new text. */
export function withBlock(text, block) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start !== -1 && end > start) return text.slice(0, start) + block.trimEnd() + text.slice(end + BLOCK_END.length);
  if (!text.trim()) return block;
  return text.replace(/\s*$/, '\n\n') + block;
}

export function withoutBlock(text) {
  const start = text.indexOf(BLOCK_START);
  const end = text.indexOf(BLOCK_END);
  if (start === -1 || end < start) return text;
  const out = (text.slice(0, start).replace(/\n+$/, '\n') + text.slice(end + BLOCK_END.length).replace(/^\n+/, '\n')).replace(/\n{3,}/g, '\n\n');
  return out.trim() ? out.replace(/\n*$/, '\n') : '';
}

/** Hook groups in a settings object that are not flowrail's own. */
const userHookGroups = (s) => Object.values((s && s.hooks) || {})
  .reduce((n, list) => n + (Array.isArray(list) ? list.filter((g) => !oursOnly(g)).length : 0), 0);

function countMd(dir) { return listFiles(dir, '.md').length; }
function countDirs(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).length; } catch { return 0; } }

const keysOf = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
function jsonFile(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

/**
 * The MCP servers this project configures: its .mcp.json, its own entry in ~/.claude.json (local
 * scope), and enabledMcpjsonServers in .claude/settings*.json. User-scope servers that every
 * project on the machine sees are left out: init suggests from what the repo shows.
 */
export function mcpServers(root, { home = os.homedir(), env = process.env } = {}) {
  const names = new Set();
  for (const n of keysOf(jsonFile(path.join(root, '.mcp.json'))?.mcpServers)) names.add(n);
  const configs = [path.join(home, '.claude.json'), ...(env.CLAUDE_CONFIG_DIR ? [path.join(env.CLAUDE_CONFIG_DIR, '.claude.json')] : [])];
  for (const file of configs) {
    const cfg = jsonFile(file);
    if (!cfg) continue;
    const projects = cfg.projects && typeof cfg.projects === 'object' ? cfg.projects : {};
    for (const [dir, proj] of Object.entries(projects)) if (path.resolve(dir) === path.resolve(root)) for (const n of keysOf(proj && proj.mcpServers)) names.add(n);
  }
  for (const f of ['settings.json', 'settings.local.json']) {
    const s = jsonFile(path.join(root, '.claude', f));
    for (const n of Array.isArray(s?.enabledMcpjsonServers) ? s.enabledMcpjsonServers : []) if (typeof n === 'string') names.add(n);
  }
  return [...names].sort();
}

/** What is already in this folder. */
export function detect(root, opts = {}) {
  const p = paths(root);
  let branch = null;
  try { branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { /* not a repo */ }
  const git = branch !== null || exists(path.join(root, '.git'));
  const claudeText = readText(path.join(root, 'CLAUDE.md'));
  const agentsText = readText(path.join(root, 'AGENTS.md'));
  let settingsValid = true;
  let settingsHooks = 0;
  if (exists(p.settings)) {
    try { settingsHooks = userHookGroups(JSON.parse(readText(p.settings))); } catch { settingsValid = false; }
  }
  const mcp = mcpServers(root, opts);
  return {
    root,
    git,
    branch,
    claudeMd: { exists: exists(path.join(root, 'CLAUDE.md')), ...scanRules(claudeText) },
    agentsMd: { exists: exists(path.join(root, 'AGENTS.md')), ...scanRules(agentsText) },
    agents: countMd(path.join(p.claudeDir, 'agents')),
    skills: countDirs(path.join(p.claudeDir, 'skills')),
    commands: countMd(path.join(p.claudeDir, 'commands')),
    settings: { exists: exists(p.settings), valid: settingsValid, hooks: settingsHooks },
    workspace: exists(p.config),
    guard: exists(path.join(root, GUARD_REL, 'hook.mjs')),
    mcp,
    permissions: permissionRules(SETTINGS_FILES.map((f) => ({ file: `.claude/${f}`, settings: jsonFile(path.join(root, '.claude', f)) }))),
    tooling: tooling(root, { ...opts, mcp }),
  };
}

// ---------- project-aware starters ----------

const MAIL_MCP = /mail|smtp|outlook|sendgrid|postmark|resend|mailgun|brevo/i;
const PAY_MCP = /stripe|paypal|braintree|adyen|mollie|paddle|lemon|payment/i;
const TOOLS = [
  { recipe: 'infra-destructive', name: 'kubectl', text: /\bkubectl\b/, files: ['k8s', 'kubernetes', 'Chart.yaml', 'kustomization.yaml'] },
  { recipe: 'infra-destructive', name: 'terraform', text: /\b(terraform|tofu)\b/, ext: '.tf' },
  { recipe: 'infra-destructive', name: 'aws', text: /\baws (s3|ec2|rds|ecs|eks|lambda|cloudformation)\b/ },
  { recipe: 'infra-destructive', name: 'gcloud', text: /\bgcloud\b/ },
  { recipe: 'infra-destructive', name: 'helm or pulumi', text: /\b(helm|pulumi)\b/, files: ['helm', 'charts', 'Pulumi.yaml'] },
  { recipe: 'db-destructive', name: 'a database', text: /\b(psql|mysql|pg_dump|mongosh|DATABASE_URL|POSTGRES_\w+|MYSQL_\w+|prisma)\b/, files: ['prisma/schema.prisma', 'db/migrate', 'alembic.ini', 'knexfile.js'] },
  { recipe: 'publish-deploy', name: 'gh', text: /\bgh (pr merge|release create)\b/ },
  { recipe: 'publish-deploy', name: 'vercel', text: /\bvercel\b/, files: ['vercel.json', '.vercel'] },
  { recipe: 'publish-deploy', name: 'fly', text: /\bfly(ctl)? deploy\b/, files: ['fly.toml'] },
  { recipe: 'publish-deploy', name: 'docker', text: /\bdocker (push|buildx)\b/, files: ['Dockerfile'] },
  { recipe: 'publish-deploy', name: 'a deploy or release script', text: /^(deploy|release|publish)[\w-]*\s*:|"(deploy|release|publish)[\w:-]*"\s*:|^\s*-?\s*(name|run|uses):.*\b(deploy|publish)\b/m },
];

/** Text of the files that say how a project builds and ships: scripts, Makefile, CI, env examples. */
function projectText(root) {
  const files = ['package.json', 'Makefile', 'justfile', 'Taskfile.yml', '.env.example', '.env.sample', '.env.template', 'docker-compose.yml', 'compose.yaml'];
  const wf = path.join(root, '.github', 'workflows');
  try { for (const f of fs.readdirSync(wf)) if (/\.ya?ml$/.test(f)) files.push(`.github/workflows/${f}`); } catch { /* none */ }
  return files.map((f) => [f, readText(path.join(root, f)).slice(0, 200000)]).filter(([, t]) => t);
}

/** Files with this extension up to three folders deep (node_modules and dot folders skipped). */
function findExt(root, ext, depth = 3) {
  const stack = [['', 0]];
  while (stack.length) {
    const [rel, d] = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isFile() && e.name.endsWith(ext)) return r;
      if (e.isDirectory() && d + 1 < depth && !e.name.startsWith('.') && e.name !== 'node_modules') stack.push([r, d + 1]);
    }
  }
  return null;
}

/**
 * Starters worth offering for this project, from what the repo itself shows (its files, scripts,
 * CI and project-scoped MCP servers), never from what happens to be installed on this machine:
 * [{ recipe, evidence: ['terraform (infra/main.tf)'] }].
 */
export function tooling(root, { env = process.env, mcp } = {}) {
  const texts = projectText(root);
  const found = new Map();
  const note = (recipe, what) => {
    if (!found.has(recipe)) found.set(recipe, []);
    if (!found.get(recipe).includes(what)) found.get(recipe).push(what);
  };
  for (const t of TOOLS) {
    const inText = texts.find(([, text]) => t.text.test(text));
    const file = (t.files || []).find((f) => exists(path.join(root, f))) || (t.ext && findExt(root, t.ext));
    if (inText) note(t.recipe, `${t.name} (${inText[0]})`);
    else if (file) note(t.recipe, `${t.name} (${file})`);
  }
  const pkg = jsonFile(path.join(root, 'package.json'));
  if (pkg && pkg.name && (pkg.publishConfig || pkg.private === false)) note('publish-deploy', 'an npm package set up to publish (package.json)');
  for (const server of mcp || mcpServers(root, { env })) {
    if (MAIL_MCP.test(server)) note('no-emails-without-signoff', `${server} (MCP server)`);
    if (PAY_MCP.test(server)) note('no-payments', `${server} (MCP server)`);
  }
  return [...found].map(([recipe, evidence]) => ({ recipe, evidence }));
}

/** Proposals from CLAUDE.md and AGENTS.md, excluding recipes that are already starter lines. */
export function proposals(found) {
  const starters = new Set(RECIPES.filter((r) => r.starter).map((r) => r.id));
  const seen = new Set();
  const out = [];
  for (const pr of [...found.claudeMd.proposals, ...found.agentsMd.proposals]) {
    if (seen.has(pr.recipe.id)) continue;
    seen.add(pr.recipe.id);
    out.push({ ...pr, starter: starters.has(pr.recipe.id) });
  }
  return out;
}

/** Bullet points in CLAUDE.md / AGENTS.md that are not rules, so init can say it skipped them. */
export const skippedLines = (found) => [...found.claudeMd.skipped, ...found.agentsMd.skipped];

/** "rule-" and the rule's words, cut on a word boundary at 40 characters: rule-always-write-tests. */
export function stubId(rule) {
  let slug = '';
  for (const w of slugify(rule, 200).split('-')) {
    if (slug && slug.length + 1 + w.length > 40) break;
    slug = slug ? `${slug}-${w}` : w.slice(0, 40);
  }
  return `rule-${slug || 'item'}`;
}

/**
 * One verdict per rule found in CLAUDE.md / AGENTS.md:
 *   covered      red lines with a hook hold what the rule says, including every command and path
 *                the rule quotes or names (probed, not claimed)
 *   partial      a red line holds part of it; `detail` says what is not held
 *   not covered  no recipe holds it (or the user declined): written as a declared-only stub
 * A quoted command or a named path that the recipe does not hold gets a generated red line of its
 * own (`lines`), unless the user declined it (`decline`); a declined one makes the rule partial.
 * @returns {{source:string, rule:string, quote:string, verdict:string, lineId:string, detail:string,
 *   stub?:object, lines?:object[], probes?:object[], recipe?:string, severity?:string}[]}
 */
export function ruleReport(found, { accept = [], existing = new Set(), decline = [], mcp = true } = {}) {
  const out = [];
  const perms = found.permissions || [];
  for (const [source, f] of [['CLAUDE.md', found.claudeMd], ['AGENTS.md', found.agentsMd]]) {
    for (const m of (f && f.matches) || []) {
      const r = m.recipe;
      const probes = literalProbes(m.rule);
      const starterOn = r && r.starter && (mcp !== false || r.id !== 'ask-before-mcp-actions');
      const enabled = r && (starterOn || existing.has(r.id) || accept.includes(r.id));
      const perm = permissionFor(m.rule, perms);
      const permHolds = perm && probes.every((pr) => typeof pr === 'string' && settingsDecision([perm], 'Bash', { command: pr }, found.root));
      if (perm && permHolds && !enabled) {
        out.push({
          source, rule: m.rule, quote: m.quote, verdict: 'covered', lineId: `settings:${perm.kind}`,
          detail: `covered by your ${perm.file} permissions.${perm.kind}: ${perm.rule} (Claude Code enforces it)`,
        });
        continue;
      }
      if (r && !enabled) {
        const id = stubId(m.rule);
        out.push({
          source, rule: m.rule, quote: m.quote, verdict: 'not covered', lineId: id,
          detail: `you did not enforce ${r.id}; kept as a declared-only red line`,
          stub: { id, title: m.quote, why: `Written in ${source}. Declared only: no hook or check holds it yet.`, severity: 'ask' },
        });
        continue;
      }
      // What the chosen recipe holds of the rule's own literals; the rest gets lines of its own.
      const severity = !r || r.starter ? undefined : recipeSeverity(r, m.rule);
      const recipeLine = r ? asRedLine(r, severity || r.severity) : null;
      const { held, missed } = probes.length && recipeLine ? probeLine(recipeLine, probes) : { held: [], missed: probes };
      const generated = literalLines(m.rule, missed, { source });
      const lines = generated.filter((l) => !decline.includes(l.id));
      const declined = generated.filter((l) => decline.includes(l.id));
      // A generated line is covered only when it holds its variants too (flag order, short forms).
      const loose = lines.flatMap((l) => verifyRedlines(null, { lines: [l], noFloor: true }).lines
        .flatMap((row) => row.positive.filter((x) => !x.ok).map((x) => x.probe)));
      const names = (list) => list.map((x) => (typeof x === 'string' ? `\`${x}\`` : x.input.file_path)).join(', ');
      if (!r && !lines.length) {
        const id = stubId(m.rule);
        out.push({
          source, rule: m.rule, quote: m.quote, verdict: 'not covered', lineId: id,
          detail: declined.length ? `you declined a red line for ${names(missed)}; kept as a declared-only red line` : 'no recipe holds this; kept as a declared-only red line so it shows up on the dashboard',
          stub: { id, title: m.quote, why: `Written in ${source}. Declared only: no hook or check holds it yet.`, severity: 'ask' },
        });
        continue;
      }
      const ids = [...(r ? [r.id] : []), ...lines.map((l) => l.id)];
      const bits = [];
      if (r) bits.push(summaryOf(recipeLine));
      if (lines.length) bits.push(`${lines.map((l) => `${l.id} (${l.severity})`).join(' and ')} hold${lines.length === 1 ? 's' : ''} what you quoted (${names(lines.flatMap((l) => l.probes.hold))})`);
      const notHeld = [...(r && r.gaps ? [r.gaps] : []), ...(declined.length ? [`${names(declined.flatMap((l) => l.probes.hold))} (you declined the red line for it)`] : []),
        ...(loose.length ? [`${loose.map((x) => `\`${x}\``).join(', ')} (a variant the generated line misses)`] : [])];
      out.push({
        source, rule: m.rule, quote: m.quote, verdict: notHeld.length ? 'partial' : 'covered', lineId: ids.join(' + '),
        detail: `${bits.join('; ')}${notHeld.length ? `. Not held: ${notHeld.join('; ')}` : ''}`,
        ...(r ? { recipe: r.id, probes: held } : {}), ...(severity ? { severity } : {}), ...(lines.length ? { lines } : {}),
        ...(generated.length ? { generated } : {}),
      });
    }
  }
  return out;
}

/** Every recipe a rule in the files maps to (including path rules made on the fly). */
const foundRecipes = (found) => [...found.claudeMd.matches, ...found.agentsMd.matches].map((m) => m.recipe).filter(Boolean);

/**
 * Plan an init. Nothing is written.
 * @param {string} root
 * @param {{room?:Function, agentsMd?:boolean, accept?:string[], mcp?:boolean, home?:string}} opts
 *   Without `room` this is the guard only: guard, red lines, hooks; no CLAUDE.md, board or docs.
 *   room({root, p, config, add, changes}) = the control room's extra files (and the CLAUDE.md block).
 *   accept = recipe ids to add as red lines; mcp: false leaves ask-before-mcp-actions out.
 */
export function planInit(root, opts = {}) {
  const p = paths(root);
  const found = detect(root, opts);
  const changes = [];
  const problems = [];
  const add = (rel, after) => { if (!exists(path.join(root, rel))) changes.push({ path: rel, kind: 'add', internal: rel.startsWith('flowrail/'), before: '', after }); };

  // The guard needs a name and the dashboard port (to hold calls to its API); the room the rest.
  const config = opts.room ? defaultConfig(path.basename(root)) : { name: path.basename(root), port: 4747 };
  add('flowrail/config.json', JSON.stringify(config, null, 2) + '\n');

  let current = null;
  if (exists(p.redlines)) {
    try { current = JSON.parse(readText(p.redlines)); } catch { problems.push('flowrail/red-lines.json is not valid JSON; not adding red lines'); }
  }
  const accept = opts.accept || [];
  const existing = new Set(Array.isArray(current) ? current.map((l) => l && l.id) : []);
  const report = ruleReport(found, { accept, existing, decline: opts.decline || [], mcp: opts.mcp });
  const recipes = [...RECIPES, ...foundRecipes(found).filter((r) => !RECIPES.some((x) => x.id === r.id))];
  // The rule's wording sets an accepted recipe's severity ("on your own" asks), and the rule's own
  // quoted commands and paths that the recipe holds become probes on the line (verify runs them).
  const tune = (line) => {
    const rows = report.filter((x) => x.recipe === line.id);
    const severity = rows.find((x) => x.severity)?.severity;
    const probes = rows.flatMap((x) => x.probes || []);
    const recipe = recipes.find((x) => x.id === line.id);
    const tuned = severity && recipe && !recipe.starter ? asRedLine(recipe, severity) : line;
    return { ...tuned, ...(probes.length ? { probes: { hold: probes, allow: [] } } : {}) };
  };
  const { lines: wanted, merged } = dedupe([
    ...starterLines().filter((l) => opts.mcp !== false || l.id !== 'ask-before-mcp-actions').map(tune),
    ...recipes.filter((r) => accept.includes(r.id)).map((r) => asRedLine(r)).map(tune),
    ...report.flatMap((x) => x.lines || []),
    ...report.filter((x) => x.stub).map((x) => x.stub),
  ], existing);
  // A rule whose line was merged into an earlier one with the same hook points at that one.
  for (const row of report) row.lineId = row.lineId.split(' + ').map((id) => merged[id] || id).join(' + ');
  if (!exists(p.redlines)) {
    add('flowrail/red-lines.json', JSON.stringify(wanted, null, 2) + '\n');
  } else if (Array.isArray(current)) {
    // A file you already keep is yours: nothing is added that a line of yours already holds (same
    // hook), and no declared-only stubs for rules you chose not to write a line for.
    const what = (l) => (l && l.hook && l.hook.builtin ? JSON.stringify([l.hook.builtin, l.hook.params || null]) : null);
    const held = new Map(current.filter(what).map((l) => [what(l), l.id]));
    const generated = new Set(report.flatMap((x) => (x.lines || []).map((l) => l.id)));
    const yours = {};
    const extra = wanted.filter((l) => {
      if (existing.has(l.id) || !(accept.includes(l.id) || generated.has(l.id))) return false;
      if (held.has(what(l))) { yours[l.id] = held.get(what(l)); return false; }
      return true;
    });
    for (const row of report) {
      const ids = row.lineId.split(' + ');
      if (!ids.some((id) => yours[id])) continue;
      row.lineId = ids.map((id) => yours[id] || id).join(' + ');
      const line = current.find((l) => l.id === yours[ids.find((id) => yours[id])]);
      row.detail = `your line ${line.id} (${line.severity}) runs the same matcher`
        + (row.detail.includes('Not held:') ? `. ${row.detail.slice(row.detail.indexOf('Not held:'))}` : '');
    }
    for (const row of report) {
      if (row.stub) row.detail = row.detail.replace(/; kept as a declared-only red line.*$/, '; not added, since red-lines.json is yours');
    }
    if (extra.length) changes.push({ path: 'flowrail/red-lines.json', kind: 'change', internal: true, before: readText(p.redlines), after: JSON.stringify([...current, ...extra], null, 2) + '\n' });
  }

  // The control room (@finalangel/flowrail-room) adds its files here: board, docs, memory, workflows.
  if (opts.room) opts.room({ root, p, config, add, changes });

  // The guard itself, copied into the repo so the hooks need no npm.
  changes.push(...planGuard(root));

  // Files outside flowrail/: previewed as diffs.
  const gi = readText(path.join(root, '.gitignore'));
  if (!/^\/?\.flowrail\/?\s*$/m.test(gi)) changes.push({ path: '.gitignore', kind: gi ? 'change' : 'add', before: gi, after: (gi && !gi.endsWith('\n') ? gi + '\n' : gi) + '# flowrail per-machine state (comments, runs, logs)\n.flowrail/\n' });

  if (opts.room || opts.block) {
    const block = opts.block || claudeBlock();
    const cm = readText(path.join(root, 'CLAUDE.md'));
    const nextCm = withBlock(cm, block);
    if (nextCm !== cm && !cm.includes(BLOCK_START)) changes.push({ path: 'CLAUDE.md', kind: cm ? 'change' : 'add', before: cm, after: nextCm });
    if (found.agentsMd.exists || opts.agentsMd) {
      const am = readText(path.join(root, 'AGENTS.md'));
      const nextAm = withBlock(am, block);
      if (nextAm !== am && !am.includes(BLOCK_START)) changes.push({ path: 'AGENTS.md', kind: am ? 'change' : 'add', before: am, after: nextAm });
    }
  }

  const hooks = planHooks(root);
  if (hooks.error) problems.push(hooks.error);
  else changes.push(...hooks.changes);

  return { found, changes, problems, report, proposals: proposals(found), skipped: skippedLines(found) };
}

const RANK = { warn: 1, ask: 2, block: 3 };

/**
 * One line per id, and one line per hook: two rules that hold the same thing (no-publish-without-
 * asking and publish-deploy both run publish-deploy) become the first line, at the stronger
 * severity. Lines already in red-lines.json (`existing`) are never merged away.
 * @returns {{lines: object[], merged: Object<string,string>}} merged: dropped id -> kept id
 */
const hookKey = (l) => (l && l.hook && l.hook.builtin
  ? JSON.stringify([l.hook.tool, l.hook.builtin, l.hook.params || null]) : null);

function dedupe(lines, existing = new Set()) {
  const seen = new Set();
  const byHook = new Map();
  const merged = {};
  const out = [];
  for (const l of lines) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    const key = hookKey(l);
    const first = key && byHook.get(key);
    if (first && !existing.has(l.id)) {
      if (RANK[l.severity] > RANK[first.severity]) first.severity = l.severity;
      merged[l.id] = first.id;
      continue;
    }
    if (key) byHook.set(key, l);
    out.push(l);
  }
  return { lines: out, merged };
}

const SETTINGS_FILES = ['settings.json', 'settings.local.json'];
const HOOKS_NOTE = 'the hooks call the guard copied into .claude/flowrail/guard/ with plain node: no npm, and they work in a fresh clone';

/**
 * Put the flowrail hooks in .claude/settings.json (committed, so everyone who clones gets them), and
 * take any flowrail hooks out of settings.local.json (an older setup), so none is left twice.
 * @returns {{changes: object[], error?: string}}
 */
export function planHooks(root) {
  const changes = [];
  for (const file of SETTINGS_FILES) {
    const rel = `.claude/${file}`;
    const before = readText(path.join(root, rel));
    let settings = {};
    if (before.trim()) {
      try { settings = JSON.parse(before); } catch { return { changes: [], error: `${rel} is not valid JSON. flowrail will not rewrite it; fix it and run \`${CLI} upgrade\`.` }; }
    }
    const pretty = before.trim() ? JSON.stringify(settings, null, 2) + '\n' : '';
    const reformatted = before.trim() && pretty !== before;
    if (file === 'settings.json') {
      const { settings: next, changed } = mergeHooks(settings);
      if (!changed.length) continue;
      const lines = HOOK_EVENTS.filter((e) => changed.includes(e.event)).map((e) => `+ ${e.event.padEnd(14)} ${e.matcher ? `matcher ${e.matcher}  ` : ''}${hookSummary(e.kind)}`);
      const kept = userHookGroups(settings);
      if (kept) lines.push(`  ${kept} existing hook group${kept === 1 ? '' : 's'} and every other setting stay as they are`);
      lines.push(`  ${HOOKS_NOTE}`);
      changes.push({ path: rel, kind: before ? 'change' : 'add', before: pretty, after: JSON.stringify(next, null, 2) + '\n', lines, summary: `hooks: ${[...new Set(changed)].join(', ')}${reformatted ? '; JSON is re-indented to 2 spaces' : ''}` });
    } else if (before.trim()) {
      const { settings: next, removed } = removeHooks(settings);
      if (!removed.length) continue;
      const after = Object.keys(next).length ? JSON.stringify(next, null, 2) + '\n' : '';
      changes.push({ path: rel, kind: after ? 'change' : 'remove', before: pretty, after, lines: [...removed.map((e) => `- ${e}  (moved to .claude/settings.json)`)], summary: 'move flowrail hooks' });
    }
  }
  return { changes };
}

export function planUnhooks(root) {
  const changes = [];
  for (const file of SETTINGS_FILES) {
    const rel = `.claude/${file}`;
    const before = readText(path.join(root, rel));
    if (!before.trim()) continue;
    let settings;
    try { settings = JSON.parse(before); } catch { return { changes: [], error: `${rel} is not valid JSON; not touching it.` }; }
    const { settings: next, removed } = removeHooks(settings);
    if (!removed.length) continue;
    const lines = removed.map((e) => `- ${e}`);
    lines.push('  other hooks and settings stay as they are');
    changes.push({ path: rel, kind: 'change', before: JSON.stringify(settings, null, 2) + '\n', after: JSON.stringify(next, null, 2) + '\n', lines, summary: 'remove flowrail hooks' });
  }
  return { changes };
}

/**
 * Restore the vendored guard, refresh the hook commands, and bring an existing CLAUDE.md/AGENTS.md
 * block to the current (two-line) text. A file without the block gets none.
 */
export function planUpgrade(root, opts = {}) {
  const changes = [...planGuard(root)];
  const problems = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const text = readText(path.join(root, file));
    if (!text.includes(BLOCK_START)) continue;
    const next = withBlock(text, opts.block || claudeBlock());
    if (next !== text) changes.push({ path: file, kind: 'change', before: text, after: next });
  }
  const hooks = planHooks(root);
  if (hooks.error) problems.push(hooks.error); else changes.push(...hooks.changes);
  return { changes, problems, note: HOOKS_NOTE };
}

export function planUninstall(root) {
  const changes = [];
  const problems = [];
  for (const file of ['CLAUDE.md', 'AGENTS.md']) {
    const text = readText(path.join(root, file));
    if (!text.includes(BLOCK_START)) continue;
    const after = withoutBlock(text);
    changes.push({ path: file, kind: after ? 'change' : 'remove', before: text, after });
  }
  const hooks = planUnhooks(root);
  if (hooks.error) problems.push(hooks.error); else changes.push(...hooks.changes);
  for (const f of [...GUARD_FILES, 'manifest.json']) {
    const rel = `${GUARD_REL}/${f}`;
    if (exists(path.join(root, rel))) changes.push({ path: rel, kind: 'remove', internal: true, before: '', after: '' });
  }
  return { changes, problems };
}

/**
 * init in a folder with no .flowrail/ whose path this machine has state for (a reused path, a
 * re-clone): that state is someone else's history. Start a fresh journal epoch instead of
 * reporting "rules changed outside flowrail" and "audit log edited". Returns the files moved aside.
 */
export function freshEpoch(root, env = process.env) {
  // Never from inside a Claude Code session: there it could launder drift. The human runs init.
  if (env.CLAUDECODE || exists(paths(root).local) || !hasState(root)) return [];
  try { return startEpoch(root, 'init in a folder without .flowrail/ (path used before on this machine)'); } catch { return []; }
}

export function apply(root, changes) {
  const epoch = freshEpoch(root);
  for (const c of changes) {
    if (c.kind === 'remove') fs.rmSync(path.join(root, c.path), { force: true });
    else writeText(path.join(root, c.path), c.after);
    // flowrail wrote the rules: the new content is the accepted one (unless it replaced drift).
    const watched = /^flowrail\/(red-lines|config)\.json$/.exec(c.path);
    if (watched) {
      try { acceptChange(root, `${watched[1]}.json`, c.kind === 'add' ? null : c.before, 'flowrail init'); } catch { /* read-only state dir */ }
    }
  }
  // .flowrail/ marks this folder's machine-local state as its own (see freshEpoch).
  if (!changes.every((c) => c.kind === 'remove')) fs.mkdirSync(paths(root).local, { recursive: true });
  // An uninstall leaves no empty guard folders behind.
  for (const dir of [`${GUARD_REL}/builtins`, GUARD_REL, '.claude/flowrail']) try { fs.rmdirSync(path.join(root, dir)); } catch { /* not empty or not there */ }
  return { epoch };
}
