// file-field: hold a command when a file it names carries a value in its frontmatter. For rules
// that depend on a record rather than on the command itself: `send.ts --lead leads/acme.md` is
// held when acme.md says `region: Germany`. Part of the vendored guard.
import fs from 'node:fs';
import path from 'node:path';
import { hold, eachCommand, resolveWord, realish, inside } from './common.js';
import { runsQuoted } from './command.js';
import { isSecretName } from './secrets.js';

const low = (s) => String(s).trim().replace(/^["']|["']$/g, '').toLowerCase();
const CAP = 64 * 1024;

/** A `key: value` line from a Markdown file's frontmatter, lower-cased; '' when absent. */
export function frontmatterField(text, key) {
  if (!text.startsWith('---\n')) return '';
  const end = text.indexOf('\n---', 4);
  const fm = end === -1 ? '' : text.slice(4, end);
  const m = fm.match(new RegExp(`^${key.replace(/[^\w-]/g, '')}:[ \\t]*(.*)$`, 'm'));
  return m ? low(m[1]) : '';
}

function readHead(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(CAP);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, CAP, 0));
  } finally { fs.closeSync(fd); }
}

// Programs that run the script named after them: `npx tsx x.ts`, `node x.js`, `bun run x.ts`.
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'node', 'tsx', 'ts-node', 'bun', 'deno', 'run',
  'exec', 'dlx', 'pnpm', 'yarn', 'npm', 'python', 'python3']);

/** Does this simple command run one of the scripts or commands the params name? */
function runs(argv, cwd, root, p) {
  if ((p.commands || []).some((c) => runsQuoted(argv, { argv: c }))) return true;
  const scripts = (p.scripts || []).map((s) => realish(resolveWord(s, root)));
  const words = argv.filter((w) => !w.startsWith('-'));
  const i = words.findIndex((w) => !RUNNERS.has(path.posix.basename(w)));
  const abs = i >= 0 && resolveWord(words[i], cwd);
  return !!abs && scripts.includes(realish(abs));
}

/** The values given to `flag` (`--lead a.md`, `--lead=a.md`); undefined for a flag with none. */
function flagValues(argv, flag) {
  const out = [];
  argv.forEach((a, i) => {
    if (a === flag) out.push(argv[i + 1]);
    else if (a.startsWith(flag + '=')) out.push(a.slice(flag.length + 1));
  });
  return out;
}

export function fileField(ctx) {
  const p = ctx.params || {};
  if (ctx.tool !== 'Bash') return null;
  const missing = p.missing || 'ask';
  return eachCommand(ctx, ({ argv }, cwd) => {
    if (!runs(argv, cwd, ctx.root, p)) return null;
    const files = flagValues(argv, p.flag);
    if (!files.length || files.includes(undefined)) {
      return hold(missing, `no ${p.flag} file, so ${p.field} cannot be checked`);
    }
    for (const f of files) {
      const abs = resolveWord(f, cwd);
      let text;
      try {
        const real = abs && realish(abs);
        if (!real || !inside(real, ctx.root) || isSecretName(real)) throw new Error('outside');
        text = readHead(real);
      } catch {
        return hold(missing, `${f} cannot be read, so ${p.field} cannot be checked`);
      }
      const excepted = Object.entries(p.except || {})
        .some(([k, vs]) => vs.map(low).includes(frontmatterField(text, k)));
      if (excepted) continue;
      const v = frontmatterField(text, p.field);
      if (p.values.some((x) => v.startsWith(low(x)))) return hold('block', `${f}: ${p.field} ${v}`);
    }
    return null;
  });
}
