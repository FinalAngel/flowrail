// flowrail-tamper, the built-in floor: the red lines, flowrail settings, the guard, Claude Code
// settings and hooks, .git/config and .git/hooks, .mcp.json, the managed CLAUDE.md block, the
// machine-local state (key, journal), the dashboard API, and git configuration that runs programs.
// Part of the vendored guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../state.js';
import { commands } from '../shell.js';
import {
  hold, has, positionals, resolveWord, realish, inside, toPosix, eachCommand, inputPaths, mcpName,
  mcpWrites, writtenText, inlineCode, codeWords, shellWritten, nameGlob, FILE_WRITE_TOOLS,
  WRITE_OPS, RUNTIMES, SHELLS, EXEC_FLAGS, isGlob, shellGlob, expandGlob, shortFlags,
} from './common.js';
import { gitConfigExec } from './git.js';

// Paths relative to a workspace root (lowercase). The guard, its rules, the hooks that call it,
// the logs it writes, and the git and MCP config an agent could use to run code behind its back.
const PROTECTED_FILES = ['flowrail/red-lines.json', 'flowrail/config.json',
  'flowrail/routines.json', '.git/config', '.mcp.json', 'node_modules/.bin/flowrail'];
const PROTECTED_DIRS = ['.claude/flowrail', '.flowrail', '.git/hooks', 'node_modules/flowrail'];
const PARENT_DIRS = new Set(['', 'flowrail', '.claude', '.git']);
export const PROTECTED = [...PROTECTED_FILES, '.claude/settings*.json',
  ...PROTECTED_DIRS.map((d) => `${d}/**`)];
/** The guard's own files (hook.mjs, builtins/git.js, ...), from the folder this file is in. */
const GUARD_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const GUARD_CODE = (function walk(dir, pre = '') {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), `${pre}${e.name}/`)
    : [`${pre}${e.name}`]));
}(GUARD_DIR)).filter((n) => n !== 'manifest.json').concat('manifest.json');
/**
 * One concrete path for every protected file, relative to a workspace root: what a glob, a folder
 * walk (find, git ls-files) or a copied tree is checked against. .flowrail/ is left out: the
 * machine-local journal and the comment signatures catch what changes there.
 */
const SAMPLES = [...PROTECTED_FILES, '.claude/settings.json', '.claude/settings.local.json',
  ...GUARD_CODE.map((f) => `.claude/flowrail/guard/${f}`), 'node_modules/flowrail/package.json',
  ...['pre-commit', 'pre-push', 'post-checkout', 'post-merge', 'commit-msg', 'prepare-commit-msg',
    'post-commit', 'pre-rebase'].map((h) => `.git/hooks/${h}`)];
/** Files in the home folder that run code or hold settings the next shell, git or agent loads. */
const HOME_FILES = ['.gitconfig', '.config/git/config', '.zshenv', '.zshrc', '.zprofile',
  '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.claude/settings.json',
  '.claude/settings.local.json', '.ssh/config', '.ssh/authorized_keys', '.ssh/rc',
  '.ssh/environment'];
const HOME_DIRS = ['.config/git', '.config/fish'];
const GUARD_WORDS = new RegExp('Application Support\\/flowrail|\\.local\\/state\\/flowrail'
  + '|FLOWRAIL_STATE_DIR|red-lines\\.json|\\.claude\\/settings[\\w.]*\\.json'
  + '|settings\\.local\\.json'
  + '|\\.claude\\/flowrail|\\.git\\/config|\\.git\\/hooks|\\.mcp\\.json|\\.flowrail\\/'
  + '|flowrail\\/config\\.json|flowrail\\/routines\\.json', 'i');
const LOCAL_HOST = new RegExp('(^|[^\\w.-])(127(\\.\\d{1,3}){1,3}|localhost|\\[?::1\\]?'
  + '|\\[?(0:){7}:?1\\]?|0\\.0\\.0\\.0|0|\\[::\\]|0x7f[0-9a-f]*|2130706433'
  + '|\\[::ffff:127\\.0\\.0\\.1\\])\\.?([^\\w.-]|$)', 'i');
const NET = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'nc', 'ncat', 'netcat',
  'socat', 'telnet', 'aria2c', 'lwp-request', 'fetch', 'websocat']);
const NPX = new Set(['npx', 'bunx', 'pnpx']);
export const BLOCK_START = '<!-- flowrail:start -->';
export const BLOCK_END = '<!-- flowrail:end -->';
const SCRIPT_EXT = /\.(m?js|cjs|ts|mts|py|sh|bash|zsh|rb|pl|php)$/i;
const COPIERS = new Set(['cp', 'mv', 'install', 'rsync', 'scp', 'ln', 'ditto']);

// Programs that only read the files they are given. Anything else that names a protected file
// is held: an editor, a patch tool, a script, an archiver.
const READ_ONLY = new Set(('cat less more head tail grep egrep fgrep rg ag ack wc diff cmp ls stat '
  + 'file jq yq bat batcat nl od xxd hexdump strings sha1sum sha256sum shasum md5 md5sum cksum '
  + 'realpath readlink dirname basename test [ [[ echo printf true false code open column sort '
  + 'uniq cut tr tree du type which command sha512sum b2sum').split(' '));
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'blame', 'ls-files', 'grep', 'add',
  'commit', 'rev-parse', 'cat-file', 'check-ignore', 'annotate', 'shortlog', 'whatchanged',
  'ls-tree', 'check-attr', 'difftool', 'hash-object']);

/** The machine-local state folders: the journal, accepted snapshots, the comment key. */
function stateDirs() {
  const home = os.homedir();
  return [stateDir(), path.join(home, 'Library', 'Application Support', 'flowrail'),
    path.join(home, '.local', 'state', 'flowrail')].map(toPosix);
}
const isState = (abs) => !!abs
  && stateDirs().some((d) => inside(abs, d) || inside(realish(abs), realish(d)));

/**
 * Claude Code's user folder when CLAUDE_CONFIG_DIR moves it away from ~/.claude (read from the
 * hook's environment, which is Claude Code's): its settings.json and settings.local.json hold
 * hooks too.
 */
function configDirs() {
  const d = process.env.CLAUDE_CONFIG_DIR;
  if (!d) return [];
  const abs = toPosix(path.resolve(d.replace(/^~(?=\/|$)/, os.homedir())));
  return [...new Set([abs, realish(abs)])];
}
const CONFIG_VAR = /^\$\{?CLAUDE_CONFIG_DIR\}?(?=\/|$)/;
/** Settings that switch every hook off, flowrail's included, in any settings file anywhere. */
const HOOKS_OFF = /disableAllHooks["'\]]?\s*(?:[:=]|\s)\s*true/;

/** 'file' for a protected path, 'dir' for a folder that holds one (or the project), else null. */
function relKind(rel) {
  if (PROTECTED_FILES.includes(rel) || /^\.claude\/settings[^/]*\.json$/.test(rel)) return 'file';
  if (PROTECTED_DIRS.some((d) => rel === d || rel.startsWith(d + '/'))) return 'file';
  return PARENT_DIRS.has(rel) ? 'dir' : null;
}

/** The managed block of CLAUDE.md / AGENTS.md at `abs`, or null when it has none. */
function managedBlock(abs) {
  if (!abs || !/^(claude|agents)\.md$/i.test(path.posix.basename(abs))) return null;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const s = text.indexOf(BLOCK_START);
  const e = text.indexOf(BLOCK_END, s);
  return s !== -1 && e !== -1 ? { text, block: text.slice(s, e + BLOCK_END.length) } : null;
}

/**
 * How a shell word relates to the guard: 'state' (the machine-local state), 'file' (a protected
 * path, symlinks resolved), 'dir' (a folder holding one), 'block' (CLAUDE.md/AGENTS.md with the
 * managed block), else null.
 */
function protectedKind(word, cwd, roots) {
  const cfg = configDirs();
  const w = cfg.length ? String(word).replace(CONFIG_VAR, cfg[0]) : String(word);
  const abs = resolveWord(w, cwd);
  const text = toPosix(word).toLowerCase();
  if (CONFIG_VAR.test(word) && /^\$\{?claude_config_dir\}?\/settings[^/]*\.json$/.test(text)) {
    return 'file';
  }
  if (abs) {
    if (isState(abs)) return 'state';
    const real = realish(abs);
    for (const d of cfg) {
      for (const x of new Set([abs, real])) {
        const rel = path.posix.relative(d, x);
        if (/^settings[^/]*\.json$/.test(rel)) return 'file';
        if (rel === '') return 'dir';
      }
    }
    const home = toPosix(os.homedir());
    for (const x of new Set([abs, real])) {
      const rel = path.posix.relative(home, x);
      if (rel.startsWith('..') || path.posix.isAbsolute(rel)) continue;
      if (HOME_FILES.includes(rel) || HOME_DIRS.some((d) => rel.startsWith(d + '/'))) return 'file';
      if (rel === '.ssh' || HOME_DIRS.includes(rel)) return 'dir';
    }
    for (const root of roots) {
      const r = toPosix(root);
      for (const [x, base] of [[abs, r], [real, realish(r)]]) {
        const rel = path.posix.relative(base, x).toLowerCase();
        if (rel === '..' || rel.startsWith('../') || path.posix.isAbsolute(rel)) continue;
        const k = relKind(rel);
        if (k) return k;
      }
      if (hookScripts(r).some((f) => f === abs || f === real)) return 'file';
    }
    if (managedBlock(real)) return 'block';
  }
  if (PROTECTED_FILES.some((p) => text === p || text.endsWith('/' + p))) return 'file';
  return /(^|\/)\.claude\/(settings[^/]*\.json|flowrail(\/|$))/.test(text) ? 'file' : null;
}

/**
 * Scripts the project's own Claude Code hooks run (.claude/hooks/check.sh named in
 * settings.json): rewriting one switches that hook off, so they are protected like the guard.
 */
const hookCache = new Map();
function hookScripts(root) {
  if (hookCache.has(root)) return hookCache.get(root);
  const out = [];
  for (const f of ['settings.json', 'settings.local.json']) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(root, '.claude', f), 'utf8'));
    } catch { continue; }
    for (const groups of Object.values((s && s.hooks) || {})) {
      for (const g of Array.isArray(groups) ? groups : []) {
        for (const h of (g && Array.isArray(g.hooks) ? g.hooks : [])) {
          const cmd = String((h && h.command) || '').replace(/\$\{?CLAUDE_PROJECT_DIR\}?/g, root);
          if (/flowrail-guard|flowrail\/guard\//.test(cmd)) continue;
          for (const c of commands(cmd)) {
            for (const w of [c.path, ...c.argv].filter(Boolean)) {
              const abs = resolveWord(w, root);
              if (abs && /[/.]/.test(w) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
                out.push(abs, realish(abs));
              }
            }
          }
        }
      }
    }
  }
  hookCache.set(root, out);
  return out;
}

const STRENGTH = { state: 4, file: 3, block: 2, dir: 1 };
/** The strongest kind among several ('state' > 'file' > 'block' > 'dir'), or null. */
const strongestKind = (list) => list.reduce((a, k) => ((STRENGTH[k] || 0) > (STRENGTH[a] || 0)
  ? k : a), null);

/** Every protected path of these roots (and the home files) that `test` accepts. */
function protectedSamples(roots, test) {
  const home = toPosix(os.homedir());
  const all = [...roots.flatMap((r) => [...SAMPLES.map((s) => `${toPosix(r)}/${s}`),
    ...hookScripts(toPosix(r))]), ...HOME_FILES.map((f) => `${home}/${f}`),
  ...configDirs().flatMap((d) => [`${d}/settings.json`, `${d}/settings.local.json`])];
  return [...new Set(all)].filter(test);
}

// protectedKind for a word the shell may expand: a glob (.claude/*/*/*.mjs) is as protected as
// the strongest path it can match, on disk now or among the protected paths.
function globKind(word, cwd, roots) {
  const k = protectedKind(word, cwd, roots);
  if (k === 'state' || k === 'file' || !isGlob(word)) return k;
  const abs = resolveWord(word, cwd);
  if (!abs) return k;
  let re;
  try { re = shellGlob(abs); } catch { return k; }
  const hits = [...protectedSamples(roots, (p) => re.test(p)), ...expandGlob(abs)];
  return strongestKind([k, ...hits.map((h) => protectedKind(h, cwd, roots))]);
}

const FIND_FILTERS = ['-name', '-iname', '-path', '-ipath', '-wholename', '-iwholename', '-regex',
  '-iregex'];

/** Does one find filter (-name x, -path x, -regex x) accept this sample path? */
function findFilter(flag, pat, abs, start) {
  try {
    if (flag.endsWith('regex')) {
      return new RegExp(`^(?:${pat})$`, flag[1] === 'i' ? 'i' : '').test(abs);
    }
    if (flag.endsWith('name')) {
      const rel = path.posix.relative(start, abs);
      return rel.split('/').some((seg) => nameGlob(pat).test(seg));
    }
    return nameGlob(pat).test(abs) || nameGlob(pat).test(`./${path.posix.relative(start, abs)}`);
  } catch { return true; }
}

/**
 * The protected paths a command that lists files would print: find (its start folders and name
 * filters), fd, git ls-files, rg --files, grep -rl, ls, echo and printf. What is piped from it into
 * `xargs <writer>` or `while read f` is checked as if it were written out. [] when it prints none
 * or the guard cannot tell (cat list.txt).
 */
function reach(cmd, cwd, roots) {
  const [bin, ...args] = cmd.argv;
  const under = (starts, test = () => true) => {
    const dirs = starts.map((s) => resolveWord(s, cwd)).filter(Boolean);
    return protectedSamples(roots, (p) => dirs.some((d) => inside(p, d) && test(p, d)));
  };
  if (bin === 'find') {
    const starts = [];
    for (const a of args) {
      if (a.startsWith('-') || a === '(' || a === '!') break;
      starts.push(a);
    }
    const filters = [];
    for (let i = 0; i < args.length; i++) {
      if (FIND_FILTERS.includes(args[i])) filters.push([args[i], String(args[i + 1] || '')]);
    }
    return under(starts.length ? starts : ['.'], (p, d) => !filters.length
      || filters.some(([f, pat]) => findFilter(f, pat, p, d)));
  }
  if (bin === 'fd' || bin === 'fdfind') {
    const pos = positionals(args);
    let re = null;
    try { re = pos[0] ? new RegExp(pos[0], 'i') : null; } catch { /* matches all */ }
    return under(pos.length > 1 ? pos.slice(1) : ['.'], (p) => !re
      || re.test(path.posix.basename(p)));
  }
  if (bin === 'git' && ['ls-files', 'ls-tree'].includes(args[0])) {
    const specs = positionals(args.slice(1)).slice(args[0] === 'ls-tree' ? 1 : 0);
    if (!specs.length) return under(['.']);
    return [...under(specs.filter((x) => !isGlob(x))), ...specs.filter(isGlob)];
  }
  const grepList = ['grep', 'egrep', 'rg', 'ag'].includes(bin)
    && (has(args, '--files', '--files-with-matches') || /l/.test(shortFlags(args)));
  if (grepList) {
    const pos = positionals(args);
    const dirs = has(args, '--files') ? pos : pos.slice(1);
    return under(dirs.length ? dirs : ['.']);
  }
  if (['ls', 'echo', 'printf'].includes(bin)) return positionals(args);
  return [];
}

/** $f and ${f} in a word, replaced by each value bound to f; the word itself when f is unbound. */
function substitute(word, vars) {
  const m = /\$\{?([A-Za-z_]\w*)\}?/.exec(word);
  if (!m || !vars[m[1]]) return [word];
  return vars[m[1]].map((v) => word.replace(m[0], () => v));
}

// Commands with loop variables and piped file lists filled in, so the checks see the paths:
//   for f in .claude/*/*/*.mjs; do cp /dev/null "$f"; done  ->  cp /dev/null .claude/*/*/*.mjs
//   find . -name 'hook.m*' | xargs truncate -s0              ->  truncate -s0 <root>/.../hook.mjs
//   git ls-files .claude | while read f; do sed -i x "$f"; done
function bindPaths(cmds, cwd, roots) {
  const vars = {};
  const out = [];
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i];
    const prev = i > 0 && cmds[i - 1].sep === '|' ? cmds[i - 1] : null;
    const [bin, name, kw, ...list] = cmd.argv;
    if (bin === 'for' && kw === 'in' && /^[A-Za-z_]\w*$/.test(name || '')) {
      vars[name] = list.length ? list : ['*'];
      continue;
    }
    for (const a of cmd.assigns || []) {
      const eq = a.indexOf('=');
      if (!cmd.argv.length) vars[a.slice(0, eq)] = [a.slice(eq + 1)];
    }
    if (bin === 'read' && prev) {
      const piped = reach(prev, cwd, roots);
      for (const v of positionals(cmd.argv.slice(1))) if (piped.length) vars[v] = piped;
      continue;
    }
    const argv = cmd.argv.flatMap((w) => substitute(w, vars));
    const redirects = cmd.redirects.flatMap((r) => substitute(r.target, vars)
      .map((target) => ({ ...r, target })));
    if (cmd.xargs && prev) argv.push(...reach(prev, cwd, roots));
    out.push({ ...cmd, argv, redirects });
  }
  return out;
}

/**
 * A recursive copy (cp -r, rsync, mv, ditto) into the project or a folder above flowrail files
 * that can land on them: a source named like a protected folder (.claude, flowrail, .git), or a
 * tree whose contents are copied (src/, src/., a glob) and that has, or may have, a protected file
 * in it.
 */
function copiesTree(bin, args, sources, dest, cwd, kind) {
  const recursive = ['rsync', 'mv', 'ditto'].includes(bin) || /[rRa]/.test(shortFlags(args))
    || has(args, '--recursive', '--archive');
  const d = resolveWord(dest, cwd);
  if (!recursive || !d || kind(dest) !== 'dir') return null;
  for (const s of sources) {
    const contents = /\/\.?$/.test(s) || isGlob(s) || bin === 'ditto';
    const name = path.posix.basename(toPosix(s).replace(/\/+$/, ''));
    if (!contents && kind(path.posix.join(d, name))) return `${bin} of ${s} over flowrail settings`;
    if (!contents) continue;
    const src = resolveWord(s.replace(/\/\.?$/, '') || '/', cwd);
    let local = false;
    try {
      local = !!src && !isGlob(s) && fs.statSync(src).isDirectory();
    } catch { /* remote or missing */ }
    if (!local) return `${bin} of ${s} (contents unknown) into ${dest}`;
    const lands = protectedSamples([d], () => true).some((p) => {
      const rel = path.posix.relative(d, p);
      return !rel.startsWith('..') && fs.existsSync(path.posix.join(src, rel));
    });
    if (lands) return `${bin} of ${s} over flowrail settings`;
  }
  return null;
}

/** The arguments after a flowrail binary, however it is invoked; null when this is not flowrail. */
export function flowrailArgs(argv) {
  const isPkg = (w) => /^(flowrail|@finalangel\/flowrail-room)(@[\w.^~<>=*-]+)?$/.test(w)
    || /(^|\/)flowrail-[\w.-]*\.tgz$/.test(w);
  const afterPkg = (list) => {
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (a === '--') continue;
      if (['-p', '--package', '-c', '--call', '-w', '--workspace'].includes(a)) { i++; continue; }
      if (a.startsWith('-')) continue;
      const base = path.posix.basename(a);
      return isPkg(a) || base === 'flowrail' || base === 'flowrail-room' ? list.slice(i + 1) : null;
    }
    return null;
  };
  const [bin, ...rest] = argv;
  const binName = path.posix.basename(bin || '');
  const own = ['flowrail', 'flowrail.js', 'flowrail-room', 'flowrail-room.js'];
  if (own.includes(binName)) return rest;
  if (NPX.has(bin)) return afterPkg(rest);
  if (['npm', 'pnpm', 'yarn'].includes(bin)) {
    if (['exec', 'x', 'dlx'].includes(rest[0])) return afterPkg(rest.slice(1));
    if (bin === 'yarn' && ['flowrail', 'flowrail-room'].includes(rest[0])) return rest.slice(1);
    return null;
  }
  if (['node', 'bun', 'deno'].includes(bin)) {
    const script = rest.find((a) => !a.startsWith('-'));
    const cli = new RegExp('(^|/)flowrail(/bin/flowrail)?\\.js$|(^|/)bin/flowrail(-room)?\\.js$'
      + '|(^|/)\\.bin/flowrail(-room)?$');
    if (script && cli.test(toPosix(script))) return rest.slice(rest.indexOf(script) + 1);
  }
  return null;
}

function tamperCli(argv) {
  const [bin, sub, ...more] = argv;
  const removes = ['uninstall', 'remove', 'rm', 'un', 'r', 'unlink'].includes(sub);
  const ours = more.some((a) => /^(flowrail|@finalangel\/flowrail-room)(@.*)?$/.test(a));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin) && removes && ours) {
    return 'uninstalling flowrail';
  }
  const args = flowrailArgs(argv);
  if (!args) return null;
  const pos = args.filter((a) => !a.startsWith('-'));
  if (pos[0] === 'room') pos.shift(); // `flowrail room <args>` delegates to the control room
  if (pos[0] === 'uninstall') return 'flowrail uninstall';
  if (pos[0] === 'hooks' && ['install', 'uninstall'].includes(pos[1])) {
    return `flowrail hooks ${pos[1]}`;
  }
  if (pos[0] === 'routines' && pos[1] === 'install') return 'flowrail routines install';
  if (pos[0] === 'redlines' && pos[1] === 'accept') return 'flowrail redlines accept';
  return null;
}

const apiHits = (text, ports) => LOCAL_HOST.test(text)
  && new RegExp(`(^|[^\\d])0*(${ports.join('|')})([^\\d]|$)`).test(text);

function localApi(argv, redirects, ports) {
  for (const r of redirects) {
    if (/^\/dev\/(tcp|udp)\//.test(r.target) && apiHits(r.target.replace(/\//g, ' '), ports)) {
      return true;
    }
  }
  const code = inlineCode(argv);
  if (code !== null) return apiHits(code, ports);
  if (!NET.has(argv[0])) return false;
  // httpie and xh read ":4747/api" as localhost:4747.
  const text = argv.slice(1).map((a) => (/^:\d+/.test(a) ? `localhost${a}` : a)).join(' ');
  return apiHits(text, ports);
}

/** Does this script text reach for the guard: its files, its hooks, or the dashboard API? */
const scriptTouchesGuard = (text, ports) => GUARD_WORDS.test(text) || apiHits(text, ports);

/** The script file a command runs (node x.mjs, bash x.sh, ./x.sh), if it exists and is small. */
function scriptText(cmd, cwd) {
  const [bin, ...args] = cmd.argv;
  let file = null;
  if (RUNTIMES.has(bin.replace(/[\d.]+$/, '')) || SHELLS.has(bin)) {
    if (inlineCode(cmd.argv) !== null || args.some((a) => /^-[a-zA-Z]*c$/.test(a))) return '';
    file = args.find((a) => !a.startsWith('-'));
  } else if (cmd.path && !cmd.path.startsWith('/')) file = cmd.path; // ./run.sh; not /usr/bin/git
  const abs = file && resolveWord(file, cwd);
  if (!abs) return '';
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 256 * 1024) return '';
    const buf = fs.readFileSync(abs);
    return buf.subarray(0, 8000).includes(0) ? '' : buf.toString('utf8');
  } catch { return ''; }
}

/** Does editing CLAUDE.md at `abs` leave its managed block exactly as it is? */
function keepsBlock(ctx, abs) {
  const mb = managedBlock(abs);
  if (!mb) return true;
  const i = ctx.input;
  let after = mb.text;
  const edit = (from, to, all) => {
    if (typeof from !== 'string' || !from) return;
    const k = after.indexOf(from);
    if (all) after = after.split(from).join(String(to ?? ''));
    else if (k !== -1) after = after.slice(0, k) + String(to ?? '') + after.slice(k + from.length);
  };
  if (ctx.tool === 'Write') after = String(i.content ?? '');
  else if (ctx.tool === 'Edit') edit(i.old_string, i.new_string, i.replace_all);
  else if (ctx.tool === 'MultiEdit') {
    for (const e of Array.isArray(i.edits) ? i.edits : []) {
      if (e) edit(e.old_string, e.new_string, e.replace_all);
    }
  } else return false;
  return after.includes(mb.block);
}

/** Files a unified diff touches: `diff --git a/x b/x`, `--- a/x`, `+++ b/x`. */
function patchTargets(text) {
  const out = new Set();
  const heads = /^(?:diff --git a\/(\S+) b\/(\S+)|(?:---|\+\+\+) (?:[ab]\/)?(\S+))/gm;
  for (const m of String(text).matchAll(heads)) {
    for (const f of [m[1], m[2], m[3]]) if (f && f !== '/dev/null') out.add(f);
  }
  return [...out];
}

function readSmall(abs) {
  try {
    const st = fs.statSync(abs);
    return st.isFile() && st.size <= 1024 * 1024 ? fs.readFileSync(abs, 'utf8') : null;
  } catch { return null; }
}

/** tar's target folder and member list, for `tar -xf a.tar`, `tar xzf a.tgz -C dir x y`. */
function tarParts(args) {
  let dir = '.';
  let archiveNext = false;
  const members = [];
  let i = 0;
  if (args[0] && !args[0].startsWith('-')) {
    archiveNext = /f/.test(args[0]);
    i = 1;
  }
  for (; i < args.length; i++) {
    const a = args[i];
    if (archiveNext && !a.startsWith('-')) { archiveNext = false; continue; }
    if (a === '-C' || a === '--directory') { dir = args[++i] ?? dir; continue; }
    if (a.startsWith('--directory=')) { dir = a.slice('--directory='.length); continue; }
    if (a === '-f' || a === '--file' || /^-[a-zA-Z]*f$/.test(a)) { i++; continue; }
    if (!a.startsWith('-')) members.push(a);
  }
  return { dir, members };
}

/** The diffs a patch or git apply call reads; null for one it cannot read (a pipe). */
function patchTexts(bin, args, redirects, cwd) {
  const texts = [];
  for (const r of redirects) {
    if (r.op === '<') texts.push(readSmall(resolveWord(r.target, cwd) || ''));
    else if (r.op === '<<' || r.op === '<<<') texts.push(r.body ?? r.target);
  }
  const iIdx = args.findIndex((a) => a === '-i' || a === '--input');
  if (iIdx !== -1) texts.push(readSmall(resolveWord(args[iIdx + 1] || '', cwd) || ''));
  if (bin === 'git') {
    for (const f of positionals(args.slice(1))) texts.push(readSmall(resolveWord(f, cwd) || ''));
  }
  return texts.length && texts.every((t) => typeof t === 'string') ? texts : null;
}

/** Pathspecs of a git checkout/restore call (option values left out). */
function pathspecs(rest) {
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-s' || a === '--source' || a === '--pathspec-from-file') { i++; continue; }
    if (a !== '--' && !a.startsWith('-')) out.push(a);
  }
  return out;
}

/**
 * Archive extraction, patches and whole-tree git restores that could write a protected file
 * without naming it. Returns what was held, or null. Stash pops, merges and checkouts of a branch
 * are not asked: the drift check catches what they change (docs/tamper-model.md).
 */
function writesUnnamed(cmd, cwd, kind, roots) {
  const { argv, redirects } = cmd;
  const [bin, ...args] = argv;
  const short = args.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
  // Where it writes: the project, a parent of it, or a folder that holds protected files.
  const risky = (dir) => {
    const abs = resolveWord(dir, cwd);
    return !abs || !!kind(dir) || roots.some((r) => inside(toPosix(r), abs));
  };
  const named = (list) => list.length > 0 && !list.some((m) => kind(m) || /[*?[]/.test(m));
  if (['tar', 'bsdtar', 'gtar'].includes(bin)) {
    const bundle = args[0] && !args[0].startsWith('-') ? args[0] : '';
    if (!(has(args, '--extract', '--get') || /x/.test(short) || /x/.test(bundle))) return null;
    const { dir, members } = tarParts(args);
    return !named(members) && risky(dir) ? `${bin} -x into ${dir}` : null;
  }
  if (bin === 'unzip') {
    if (/[ltvpZ]/.test(short)) return null;
    const dIdx = args.indexOf('-d');
    const dir = dIdx !== -1 ? args[dIdx + 1] : '.';
    const pos = args.filter((a, i) => !a.startsWith('-') && (dIdx === -1 || i !== dIdx + 1));
    return !named(pos.slice(1)) && risky(dir) ? `unzip into ${dir}` : null;
  }
  if (['7z', '7za', '7zz'].includes(bin) && ['x', 'e'].includes(args[0])) {
    const o = args.find((a) => a.startsWith('-o'));
    const dir = o ? o.slice(2) : '.';
    return risky(dir) ? `${bin} ${args[0]} into ${dir}` : null;
  }
  const cpio = bin === 'cpio' && (/i/.test(short) || has(args, '--extract'));
  if ((cpio || (bin === 'pax' && /r/.test(short))) && risky('.')) return `${bin} extracting here`;
  if (bin === 'patch' || (bin === 'git' && args[0] === 'apply')) {
    const name = bin === 'git' ? 'git apply' : 'patch';
    if (has(args, '--dry-run', '--check', '--stat', '--numstat', '--summary', '--cached')) {
      return null;
    }
    const texts = patchTexts(bin, args, redirects, cwd);
    if (!texts) return risky('.') ? `${name} with a diff the guard cannot read` : null;
    const hit = texts.flatMap(patchTargets).find((f) => kind(f));
    return hit ? `${name} that changes ${hit}` : null;
  }
  if (bin === 'git') {
    const [sub, ...rest] = args;
    if (sub === 'checkout-index' && has(rest, '-a', '--all')) return 'git checkout-index --all';
    if (sub === 'read-tree' && has(rest, '-u')) return 'git read-tree -u';
    const specs = pathspecs(rest);
    const wide = specs.some((p) => [':/', '*', ':/*'].includes(p) || kind(p));
    const source = has(rest, '--source') || rest.includes('-s');
    if (sub === 'restore' && source && wide) return 'git restore --source over flowrail settings';
    if (sub === 'checkout' && wide) return 'git checkout over flowrail settings';
  }
  return null;
}

function fileTools(ctx, roots, cwd0) {
  const mcp = mcpName(ctx.tool);
  if (ctx.tool === 'Read' || ctx.tool === 'Grep' || (mcp && !mcpWrites(mcp.tool))) {
    const files = inputPaths(ctx.input);
    return files.some((f) => protectedKind(String(f), cwd0, roots) === 'state')
      ? hold('block', 'reading flowrail machine state (the comment key, the journal)') : null;
  }
  if (!FILE_WRITE_TOOLS.has(ctx.tool) && !mcp) return null;
  if (HOOKS_OFF.test(writtenText(ctx))) {
    return hold('block', 'writing disableAllHooks, which switches every hook off');
  }
  for (const file of inputPaths(ctx.input)) {
    const kind = protectedKind(String(file), cwd0, roots);
    const name = path.posix.basename(toPosix(file));
    if (kind === 'file' || kind === 'state') return hold('block', `editing ${name}`);
    if (kind === 'dir' && mcp) {
      return hold('block', `changing ${name}, which holds flowrail settings`);
    }
    if (kind === 'block' && !keepsBlock(ctx, realish(resolveWord(file, cwd0) || ''))) {
      return hold('block', `changing the flowrail block in ${name}`);
    }
    if (SCRIPT_EXT.test(name) && scriptTouchesGuard(writtenText(ctx), ctx.ports)) {
      return hold('block',
        `a script (${name}) that touches flowrail settings or the dashboard API`);
    }
  }
  return null;
}

/** One simple command against the floor. */
function checkCommand(cmd, cwd, ctx, roots) {
  const { argv, redirects } = cmd;
  // Globs are expanded (against the disk and the protected paths) wherever a command writes.
  const kind = (w) => globKind(w, cwd, roots);
  for (const r of redirects) {
    const k = kind(r.target);
    if (k === 'state') {
      return hold('block', `reading or writing flowrail machine state (${r.target})`);
    }
    if (!WRITE_OPS.has(r.op)) continue;
    if (k === 'file' || (k === 'block' && r.op !== '>>' && r.op !== '&>>')) {
      return hold('block', `writing ${r.target}`);
    }
    if (SCRIPT_EXT.test(r.target) && scriptTouchesGuard(shellWritten(cmd), ctx.ports)) {
      return hold('block', `a script (${r.target}) that touches flowrail settings or the API`);
    }
  }
  const [bin0, ...args0] = argv;
  const reader = READ_ONLY.has(bin0) || (bin0 === 'git' && GIT_READ.has(args0[0]))
    || (bin0 === 'sed' && !args0.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)));
  const bodies = redirects.filter((r) => r.body).map((r) => r.body).join('\n');
  if (HOOKS_OFF.test(shellWritten(cmd)) || (!reader && HOOKS_OFF.test(argv.join(' ') + bodies))) {
    return hold('block', 'writing disableAllHooks, which switches every hook off');
  }
  const config = gitConfigExec(cmd);
  if (config) return hold('block', config);
  const cli = tamperCli(argv);
  if (cli) return hold('block', cli);
  if (localApi(argv, redirects, ctx.ports)) {
    return hold('block', 'a call to the flowrail dashboard API');
  }
  const [bin, ...args] = argv;
  if (!bin) return null;
  const pos = positionals(args);
  // Every word, and every value after = or between commas (of=x, --cacheinfo 100644,sha,path).
  const wordsOf = args.flatMap((a) => [a, ...a.split(/[=,]/).slice(1)])
    .filter((w) => w && !w.startsWith('-'));
  if (wordsOf.some((w) => protectedKind(w, cwd, roots) === 'state')) {
    return hold('block', 'reading flowrail machine state (the comment key, the journal)');
  }
  const code = inlineCode(argv);
  const touches = (c) => GUARD_WORDS.test(c) || codeWords(c).some((w) => kind(w) === 'file');
  if (code !== null && touches(code)) {
    return hold('block', 'a script touching flowrail settings');
  }
  const script = scriptText(cmd, cwd);
  if (script && scriptTouchesGuard(script, ctx.ports)) {
    return hold('block', 'running a script that touches flowrail settings or the dashboard API');
  }
  const isFile = (a) => kind(a) === 'file' || kind(a) === 'block';
  if (bin === 'rm' && pos.some((a) => kind(a) === 'dir')) {
    return hold('block', 'rm on flowrail settings');
  }
  if (bin === 'tee' && has(args, '-a', '--append') && pos.every((a) => kind(a) !== 'file')) {
    return null;
  }
  if (bin === 'ln') {
    // A link to (or over) a protected file lets the next command write it under another name.
    if (pos.some(isFile)) return hold('block', 'a link to flowrail settings');
    if (pos.length >= 2 && kind(pos[0]) === 'dir') {
      return hold('block', 'a link to a folder that holds flowrail settings');
    }
  }
  if (COPIERS.has(bin) && pos.length >= 2) {
    const dest = pos[pos.length - 1];
    const sources = pos.slice(0, -1);
    if (isFile(dest)) return hold('block', `${bin} over flowrail settings`);
    const d = resolveWord(dest, cwd);
    const into = (s) => kind(path.posix.join(d, path.posix.basename(toPosix(s)))) === 'file';
    if (kind(dest) === 'dir' && d && sources.some(into)) {
      return hold('block', `${bin} over flowrail settings`);
    }
    if (bin === 'mv' && sources.some((s) => kind(s))) {
      return hold('block', 'moving flowrail settings away');
    }
    const tree = copiesTree(bin, args, sources, dest, cwd, kind);
    return tree ? hold('block', tree) : null; // otherwise cp, rsync and scp only read their sources
  }
  if (bin === 'find') {
    // -exec cat {} + only reads; -exec sed -i, -exec rm and -delete write.
    const execs = argv.map((a, i) => (EXEC_FLAGS.includes(a) ? argv[i + 1] : null))
      .filter((b) => b !== null && b !== undefined);
    const writes = (b) => !(READ_ONLY.has(path.posix.basename(b)) && b !== 'sed');
    const acts = argv.includes('-delete') || argv.includes('-fprint') || execs.some(writes);
    if (!acts) return null;
    const end = argv.findIndex((a) => EXEC_FLAGS.includes(a));
    const hit = reach({ argv: end === -1 ? argv : argv.slice(0, end) }, cwd, roots)[0];
    const name = hit && path.posix.basename(hit);
    return hit ? hold('block', `find -delete/-exec that reaches ${name}`) : null;
  }
  const unnamed = writesUnnamed(cmd, cwd, kind, roots);
  if (unnamed) return hold('block', unnamed);
  // Anything else that names a protected file and is not a known reader: an editor, a patch
  // tool, an archiver, a script. Asked, because the guard cannot tell what it will do.
  const guardHook = bin === 'node'
    && /\.claude\/flowrail\/guard\/hook\.mjs$/.test(toPosix(args[0] || ''));
  const sedRead = bin === 'sed' && !args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));
  const readOnly = READ_ONLY.has(bin) || sedRead || flowrailArgs(argv) !== null || guardHook
    || (bin === 'git' && GIT_READ.has(args[0]));
  if (readOnly) return null;
  const named = wordsOf.find((w) => isFile(w) || path.posix.basename(w) === 'red-lines.json');
  return named ? hold('block', `${bin} on ${named}`) : null;
}

export function flowrailTamper(ctx) {
  const roots = ctx.roots && ctx.roots.length ? ctx.roots : [ctx.root];
  if (ctx.tool !== 'Bash') return fileTools(ctx, roots, ctx.cwd || ctx.root);
  const cmds = bindPaths(ctx.cmds, ctx.cwd || ctx.root, roots);
  return eachCommand({ ...ctx, cmds }, (cmd, cwd) => checkCommand(cmd, cwd, ctx, roots));
}
