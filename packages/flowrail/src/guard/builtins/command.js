// command: one command a rule quotes (`git commit --no-verify`), matched on its argv: the program,
// its subcommand words in order, and every required flag in any order, long or short, bundled or
// not (`git commit -m fix --no-verify`, `git commit -nm fix`). Part of the vendored guard.
import path from 'node:path';
import { hold, eachCommand, positionals } from './common.js';

// Long flag -> short letter, per command and then for everything. Only aliases that hold across
// the tools that use them; a flag without one matches in its long form (and its abbreviations).
const ALIASES = {
  'git commit': { '--no-verify': 'n', '--all': 'a' },
  'git push': { '--force': 'f', '--delete': 'd' },
  'git merge': { '--no-verify': null },
  'git clean': { '--force': 'f', '--dry-run': 'n' },
  'git branch': { '--force': 'f', '--delete': 'd' },
  '*': { '--force': 'f', '--recursive': 'r', '--all': 'a', '--yes': 'y' },
};

/** { argv: ['git', 'commit'], flags: ['--no-verify'] } from a quoted command, or null. */
export function parseQuoted(text) {
  const t = String(text).trim();
  if (!t || /[|;&<>$`(){}\\*?"']/.test(t)) return null;
  const words = t.split(/\s+/);
  const argv = words.filter((w) => !w.startsWith('-'));
  const flags = words.filter((w) => w.startsWith('-') && w !== '-' && w !== '--')
    .flatMap((w) => (/^-[a-zA-Z]{2,}$/.test(w) ? [...w.slice(1)].map((l) => `-${l}`) : [w]));
  return argv.length ? { argv, flags } : null;
}

const aliasTable = (argv) => ({ ...ALIASES['*'], ...(ALIASES[argv.slice(0, 2).join(' ')] || {}) });

/** The long and short spellings of one required flag. */
function spellings(flag, argv) {
  const table = aliasTable(argv);
  if (flag.startsWith('--')) {
    const long = flag.split('=')[0];
    return { long, short: table[long] || null };
  }
  const letter = flag.slice(1, 2);
  const long = Object.keys(table).find((k) => table[k] === letter) || null;
  return { long, short: letter };
}

function hasFlag(args, flag, argv) {
  const { long, short } = spellings(flag, argv);
  for (const a of args) {
    if (a === '--') break;
    if (long && a.startsWith('--')) {
      const name = a.split('=')[0];
      // git and most parsers accept an unambiguous prefix: --no-verif
      if (name === long || (name.length >= 6 && long.startsWith(name))) return true;
    }
    if (short && /^-[a-zA-Z0-9]+$/.test(a) && a.slice(1).includes(short)) return true;
  }
  return false;
}

/** Does one simple command run what params describe? */
export function runsQuoted(argv, params) {
  const want = params.argv;
  if (!argv.length || path.posix.basename(argv[0]) !== want[0]) return false;
  const pos = positionals(argv.slice(1));
  let at = 0;
  for (const w of want.slice(1)) {
    const i = pos.indexOf(w, at);
    // Subcommand words come first (a value or two of a global option may sit before them).
    if (i === -1 || i > at + 2) return false;
    at = i + 1;
  }
  return (params.flags || []).every((f) => hasFlag(argv.slice(1), f, want));
}

export function quotedCommand(ctx) {
  const params = ctx.params || {};
  if (ctx.tool !== 'Bash' || !Array.isArray(params.argv) || !params.argv.length) return null;
  const text = [...params.argv, ...(params.flags || [])].join(' ');
  return eachCommand(ctx, ({ argv }) => (runsQuoted(argv, params) ? hold('block', text) : null));
}

/**
 * Probes that vary what a regex prefix would miss: the flags after another argument, the short
 * form bundled, sudo in front. Allowed: the same command without the flags.
 */
export function commandVariants(params) {
  const { argv, flags = [] } = params;
  const base = argv.join(' ');
  const hold = [[base, ...flags].join(' '), `sudo ${[base, ...flags].join(' ')}`];
  if (flags.length) {
    hold.push(`${base} probe ${[...flags].reverse().join(' ')}`);
    const shorts = flags.map((f) => spellings(f, argv).short);
    if (shorts.every(Boolean)) hold.push(`${base} -${shorts.join('')}`);
    const longs = flags.map((f) => spellings(f, argv).long);
    if (longs.every(Boolean)) hold.push(`${base} ${longs.join(' ')}`);
  }
  const allow = flags.length ? [`${base} probe`] : [`${argv[0]} --version`];
  return { hold: [...new Set(hold)], allow };
}
