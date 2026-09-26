// flowrail doctor: environment and workspace checks, each with a fix.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readJson } from './util.js';
import { validateLines, loadForHook, driftStatus } from './redlines.js';
import { hooksStatus, localSettings, cliName } from './hooks.js';
import { verifyJournal } from './journal.js';

function version(cmd, args = ['--version']) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? (r.stdout.trim().split('\n')[0] || cmd) : null;
  } catch { return null; }
}

/**
 * @param {object|null} p  workspace paths, or null when no workspace was found
 * @param {object} [_opts] unused; kept so callers that pass options keep working
 * @returns {Promise<{id:string,title:string,status:'ok'|'warn'|'fail',detail:string,fix?:string}[]>}
 */
export async function run(p, _opts = {}) {
  const out = [];
  const add = (id, title, status, detail, fix) => out.push({ id, title, status, ok: status === 'ok', level: status, detail, ...(fix ? { fix } : {}) });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js', major >= 20 ? 'ok' : 'fail', `v${process.versions.node}`, major >= 20 ? '' : 'Install Node.js 20 or newer');

  const git = version('git');
  add('git', 'git', git ? 'ok' : 'warn', git || 'not found', git ? '' : 'Optional. The git red lines only matter where git is');
  const claude = version('claude');
  add('claude', 'Claude Code', claude ? 'ok' : 'warn', claude || 'not found', claude ? '' : 'The guard runs as a Claude Code hook: https://docs.claude.com/claude-code');

  if (!p) {
    add('workspace', 'Workspace', 'fail', 'no flowrail/config.json here or in a parent folder', 'npx flowrail init');
    return out;
  }
  add('workspace', 'Workspace', 'ok', p.root);

  const cli = cliName();
  const hs = hooksStatus(p);
  for (const [name, file] of [['.claude/settings.json', p.settings], ['.claude/settings.local.json', localSettings(p)]]) {
    try { readJson(file, {}); } catch (e) { add('settings', name, 'fail', e.message, 'Fix the JSON by hand; flowrail never rewrites a file it cannot parse'); }
  }
  if (!hs.installed) add('hooks', 'Guard hooks', 'fail', hs.problem, `${cli} init`);
  else if (!hs.healthy && !hs.guard.verified) add('hooks', 'Guard hooks', 'ok', `in .claude/${hs.where}`);
  else if (!hs.healthy) add('hooks', 'Guard hooks', 'fail', hs.problem, `${cli} upgrade`);
  else add('hooks', 'Guard hooks', 'ok', `in .claude/${hs.where}: node checks .claude/flowrail/guard/ against its manifest, then runs it (no npm; fails closed). The one-line command, part by part: https://github.com/FinalAngel/flowrail/blob/main/docs/hooks.md#the-hook-command-part-by-part`);
  if (hs.installed) {
    const g = hs.guard;
    add('guard', 'Guard files', g.verified ? 'ok' : 'fail', g.verified ? `${g.version}, every file matches its manifest and this flowrail` : hs.problem, g.verified ? '' : `${cli} upgrade`);
  }

  const loaded = loadForHook(p);
  if (loaded.error) add('redlines', 'Red lines', 'fail', `flowrail/red-lines.json: ${loaded.error}. Until it is fixed every tool call asks first`, 'Fix flowrail/red-lines.json');
  else {
    const lines = loaded.lines;
    const errors = validateLines(lines);
    add('redlines', 'Red lines', errors.length ? 'fail' : lines.length ? 'ok' : 'warn', errors.length ? `${errors.join('; ')}. A broken line asks on every call it could match` : lines.length ? `${lines.length} valid, every hook compiles; protect-flowrail is always on` : '0 lines of your own; only the built-in protect-flowrail floor is active', errors.length ? 'Fix flowrail/red-lines.json' : lines.length ? '' : `${cli} redlines add --list`);
  }

  const d = driftStatus(p);
  add('drift', 'Rule changes', d.changed ? 'fail' : 'ok', d.changed
    ? `Rules changed outside flowrail: ${d.files.join(', ')}. Every tool call asks until you review the change`
    : 'red-lines.json and config.json match what flowrail last accepted', d.changed ? `${cli} redlines accept` : '');

  try {
    const j = verifyJournal(p);
    add('journal', 'Audit log', j.ok ? 'ok' : 'fail', j.ok ? `.flowrail/redlines.log matches the machine-local journal (${j.entries} entr${j.entries === 1 ? 'y' : 'ies'})` : `Audit log edited: ${j.problems.join('; ')}`, j.ok ? '' : `Compare with ${j.file}`);
  } catch (e) { add('journal', 'Audit log', 'warn', `could not read the machine-local journal: ${e.message}`); }

  const gi = fs.existsSync(`${p.root}/.gitignore`) ? fs.readFileSync(`${p.root}/.gitignore`, 'utf8') : '';
  add('gitignore', '.gitignore', /^\/?\.flowrail\/?$/m.test(gi) ? 'ok' : 'warn', /^\/?\.flowrail\/?$/m.test(gi) ? '.flowrail/ is ignored' : '.flowrail/ (per-machine state) is not ignored', /^\/?\.flowrail\/?$/m.test(gi) ? '' : 'echo ".flowrail/" >> .gitignore');

  return out;
}
