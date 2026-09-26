// flowrail audit: what the current red lines would have done to this project's recent Claude Code sessions.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { starterLines } from '../core/recipes.js';
import { out, c, json } from './ui.js';
import { workspace } from './main.js';
import { auditSummary } from '../core/audit.js';

const tilde = (s) => s.split(os.homedir() + '/').join('~/');
const n = (x) => x.toLocaleString('en-US');
const plural = (k, one, many = one + 's') => `${n(k)} ${k === 1 ? one : many}`;

/** "6 no-push-without-asking, 1 secret-files" for the entries in `list`. */
function breakdown(list) {
  const by = {};
  for (const e of list) by[e.line] = (by[e.line] || 0) + 1;
  return Object.entries(by).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id, k]) => `${k} ${id}`).join(', ');
}

/** Print a summary; shared with init, which offers it at the end. */
export function printAudit(r, opts = {}) {
  const limit = opts.limit ?? 20;
  if (r.note && !r.calls) return out(c.dim(tilde(r.note)));
  out(`${c.bold(`Last ${plural(r.days, 'day')}:`)} ${plural(r.calls, 'tool call')} in ${plural(r.sessions, 'session')}.`);
  const held = r.held.length ? `would have held ${n(r.held.length)} (${breakdown(r.held)})` : 'would have held nothing';
  const asked = r.asked.length ? ` and asked first on ${n(r.asked.length)} (${breakdown(r.asked)})` : '';
  out(`flowrail ${held}${asked}.`);
  const vs = r.vsSettings;
  let rows = [...r.held.map((e) => ['held', e]), ...r.asked.map((e) => ['asked', e])].sort((a, b) => b[1].at.localeCompare(a[1].at));
  if (vs && rows.length) {
    const own = vs.rules ? `Your settings.json permissions (${plural(vs.rules, 'deny/ask rule')}) would have caught ${n(vs.caught)}` : 'Your settings.json has no permissions.deny or ask rules, so it would have caught none';
    out(`${own}; flowrail adds ${n(vs.added)}${vs.added ? ':' : '.'}`);
    if (vs.hooks) out(c.dim(`(${plural(vs.hooks, 'PreToolUse hook')} of your own not replayed: flowrail does not run your scripts.)`));
    rows = rows.filter(([, e]) => !e.settings);
  }
  if (rows.length) out('');
  for (const [kind, e] of rows.slice(0, limit)) {
    const at = new Date(e.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    out(`  ${(kind === 'held' ? c.red : c.yellow)(kind.padEnd(5))}  ${c.dim(at.padEnd(14))}  ${e.line.padEnd(24)}  ${e.tool === 'Bash' ? '' : `${e.tool} `}${e.subject.replace(/\s+/g, ' ').slice(0, 90)}`);
  }
  if (rows.length > limit) out(c.dim(`  ...and ${rows.length - limit} more (--all, or --json)`));
  out(c.dim('held = blocked, it never runs; asked = Claude Code asks you first.'));
  if (opts.demo) return out(c.dim('\nRun it on your own sessions: npx flowrail audit (read-only, local, no model).'));
  out(c.dim(`\nRead-only: transcripts in ${tilde(r.transcriptsDir)} were read on this machine; nothing was sent or written, no model was called.`));
}

const DEMO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo');
const DEMO_ROOT = '/work/acme-shop';

/** The bundled fictional transcripts, replayed through the starter red lines. */
export function demoAudit() {
  return auditSummary(DEMO_ROOT, {
    days: 30, env: { CLAUDE_CONFIG_DIR: DEMO }, now: Date.parse('2026-06-10T00:00:00Z'), lines: starterLines(), settingsFrom: DEMO,
  });
}

export function audit(_pos, flags) {
  if (flags.demo) {
    const r = demoAudit();
    if (flags.json) return json(r);
    out(c.dim('Demo: fictional transcripts bundled with flowrail (a made-up project, /work/acme-shop, whose settings.json denies git push --force and asks before git push), replayed through the starter red lines.\n'));
    printAudit({ ...r, transcriptsDir: path.join(DEMO, 'projects') }, { limit: flags.all ? Infinity : 20, demo: true });
    return;
  }
  const p = workspace();
  const r = auditSummary(p.root, { days: Number(flags.days) || 30, settings: !flags['no-vs-settings'] });
  if (flags.json) return json(r);
  printAudit(r, { limit: flags.all ? Infinity : 20 });
}
