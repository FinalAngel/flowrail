// Terminal output helpers, argument parsing, prompts and diff previews for the CLI.
import readline from 'node:readline/promises';

const tty = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const wrap = (open, close) => (s) => (tty ? `\x1b[${open}m${s}\x1b[${close}m` : String(s));
export const c = {
  bold: wrap(1, 22), dim: wrap(2, 22), green: wrap(32, 39), red: wrap(31, 39), yellow: wrap(33, 39), cyan: wrap(36, 39),
};
export const mark = { ok: c.green('✓'), warn: c.yellow('!'), fail: c.red('✗'), dot: c.dim('·'), arrow: c.dim('→') };

export const out = (...s) => console.log(...s);
/** One line under every verify, redlines and test result. */
export const LEGEND = 'held = dangerous examples stopped; allowed = harmless examples let through; block = never runs; ask = Claude Code asks you first';
/** The word people read for a decision: Claude Code's "deny" is "block" everywhere but its JSON. */
export const word = (decision) => (decision === 'deny' ? 'block' : decision);
export const err = (s) => console.error(`${c.red('flowrail:')} ${s}`);

const BOOL = new Set(['yes', 'y', 'json', 'all', 'force', 'agent', 'no-open', 'agents-md', 'minimal', 'raw', 'help', 'h', 'version', 'v', 'list', 'wait', 'no-wait', 'diff', 'no-global', 'no-dev-dep', 'demo', 'no-vs-settings', 'vs-settings']);

/** Tiny argv parser: positionals, --flag, --key value, --key=value. */
export function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.length === 2 && a[0] === '-' && a[1] !== '-')) {
      const body = a.replace(/^--?/, '');
      const eq = body.indexOf('=');
      if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
      if (BOOL.has(body) || argv[i + 1] === undefined || argv[i + 1].startsWith('--')) flags[body] = true;
      else flags[body] = argv[++i];
    } else pos.push(a);
  }
  if (flags.y) flags.yes = true;
  if (flags.h) flags.help = true;
  if (flags.v) flags.version = true;
  return { flags, pos };
}

export async function confirm(question, def = true) {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const a = (await rl.question(`${question} ${c.dim(def ? '[Y/n]' : '[y/N]')} `)).trim().toLowerCase();
    return a ? a.startsWith('y') : def;
  } finally {
    rl.close();
  }
}

/** Line diff (LCS) with two lines of context. Good enough for config files. */
export function diffLines(before, after, context = 2) {
  const a = before ? before.replace(/\n$/, '').split('\n') : [];
  const b = after ? after.replace(/\n$/, '').split('\n') : [];
  // O(n*m) LCS table: fine for CLAUDE.md-sized files; past the cap it shows a plain replace.
  if (a.length * b.length > 4e6) return [...a.map((l) => `- ${l}`), ...b.map((l) => `+ ${l}`)];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { ops.push([' ', a[i]]); i++; j++; }
    else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) ops.push(['+', b[j++]]);
    else ops.push(['-', a[i++]]);
  }
  const keep = ops.map((o, k) => o[0] !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x[0] !== ' '));
  const lines = [];
  let skipped = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!skipped) lines.push('  ...'); skipped = true; return; }
    skipped = false;
    lines.push(`${o[0]} ${o[1]}`);
  });
  return lines;
}

export function printDiff(before, after, indent = '    ') {
  for (const l of diffLines(before, after)) {
    const colored = l.startsWith('+') ? c.green(l) : l.startsWith('-') ? c.red(l) : c.dim(l);
    out(indent + colored);
  }
}

export function json(data) {
  process.stdout.write(JSON.stringify(data, null, 2) + '\n');
}

export function ago(iso) {
  if (!iso) return 'never';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 0) return 'soon';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function when(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}
