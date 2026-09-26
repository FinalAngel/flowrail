// Helpers shared by the built-in matchers: flags, paths, tool inputs.
// Part of the vendored guard: imports node: builtins and guard files only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>']);
export const RUNTIMES = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl',
  'php']);
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
export const EXEC_FLAGS = ['-exec', '-execdir', '-ok', '-okdir'];

/** A matcher's answer: the most it asks for, and the thing it held. */
export const hold = (severity, what) => ({ severity, what });
export const shortFlags = (argv) => argv.filter((a) => /^-[a-zA-Z]+$/.test(a)).join('');
export const has = (argv, ...flags) => argv.some((a) => flags.includes(a)
  || flags.some((f) => f.startsWith('--') && a.startsWith(f + '=')));

export function positionals(argv) {
  const out = [];
  let rest = false;
  for (const a of argv) {
    if (rest) out.push(a);
    else if (a === '--') rest = true;
    else if (!a.startsWith('-') || a === '-') out.push(a);
  }
  return out;
}

/** The strongest of several holds (block beats ask), or null. */
export const strongest = (list) => list.filter(Boolean)
  .sort((a, b) => (a.severity === 'block' ? -1 : 1) - (b.severity === 'block' ? -1 : 1))[0] || null;

// ---------- paths ----------

export const toPosix = (p) => String(p).split(path.sep).join('/');

/** Resolve a shell word to an absolute path. null when it depends on a variable or substitution. */
export function resolveWord(word, cwd, home = os.homedir()) {
  let w = String(word);
  if (w === '~' || w.startsWith('~/')) w = home + w.slice(1);
  else if (/^\$\{?HOME\}?(\/|$)/.test(w)) w = w.replace(/^\$\{?HOME\}?/, home);
  if (w.startsWith('~') || /[$`]/.test(w)) return null;
  return path.posix.resolve(toPosix(cwd), toPosix(w));
}

/** The path with every symlink in its existing part resolved; the missing tail is kept as is. */
export function realish(abs) {
  const rest = [];
  let probe = abs;
  for (;;) {
    try {
      const r = toPosix(fs.realpathSync(probe));
      return rest.length ? path.posix.join(r, ...rest.reverse()) : r;
    } catch { /* not there (yet) */ }
    const up = path.posix.dirname(probe);
    if (up === probe) return abs;
    rest.push(path.posix.basename(probe));
    probe = up;
  }
}

/**
 * Where a path lands with symlinks resolved. Its folders are always followed; the last part only
 * when `follow` (a trailing slash, a read or a write through it). A link made earlier on the same
 * command line (`ln -s content c2; rm -rf c2/`) counts too: `links` maps link -> target.
 */
export function realPath(abs, { follow = false, links = {} } = {}) {
  for (const [link, target] of Object.entries(links)) {
    if (abs === link && !follow) break;
    if (abs === link || abs.startsWith(link + '/')) return realish(target + abs.slice(link.length));
  }
  if (follow) return realish(abs);
  return path.posix.join(realish(path.posix.dirname(abs)), path.posix.basename(abs));
}

/** Record `ln -s target link` in `links` (see realPath). */
export function trackLink(argv, cwd, links) {
  if (argv[0] !== 'ln' || !/s/.test(shortFlags(argv.slice(1)))) return;
  const pos = positionals(argv.slice(1));
  if (pos.length < 2) return;
  const target = resolveWord(pos[0], cwd);
  let link = resolveWord(pos[pos.length - 1], cwd);
  if (!target || !link) return;
  try {
    if (fs.statSync(link).isDirectory()) link = path.posix.join(link, path.posix.basename(target));
  } catch { /* a new link */ }
  links[link] = target;
}

export const inside = (abs, dir) => abs === dir
  || abs.startsWith(dir.endsWith('/') ? dir : dir + '/');
export const GLOB_ALL = /^(\*|\.\*|\{\*,\.\*\}|\.\[!.\]\*)$/;

/**
 * Walk the simple commands of a Bash call, tracking `cd` so relative paths resolve
 * the way the shell would. Calls fn(cmd, cwd, index) for every command that is not a cd.
 */
export function eachCommand(ctx, fn) {
  let cwd = ctx.cwd || ctx.root;
  for (let i = 0; i < ctx.cmds.length; i++) {
    const cmd = ctx.cmds[i];
    const [bin, arg] = cmd.argv;
    if ((bin === 'cd' || bin === 'pushd') && cmd.argv.length <= 2) {
      const next = resolveWord(arg ?? '~', cwd);
      if (next) cwd = next;
      continue;
    }
    const r = fn(cmd, cwd, i);
    if (r) return r;
  }
  return null;
}

// ---------- tool inputs ----------

const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'source', 'destination', 'target', 'from',
  'to', 'filename', 'file', 'uri'];

/** Every path-like value in a non-Bash tool's input (file tools, MCP filesystem tools). */
export function inputPaths(input) {
  const out = [];
  for (const k of PATH_KEYS) {
    const v = input[k];
    if (typeof v === 'string' && v) out.push(v.replace(/^file:\/\//, ''));
  }
  for (const k of ['paths', 'files']) {
    if (Array.isArray(input[k])) for (const v of input[k]) if (typeof v === 'string') out.push(v);
  }
  return out;
}

/** mcp__server__tool -> { server, tool }; null for anything else. */
export function mcpName(name) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(name));
  return m ? { server: m[1], tool: m[2] } : null;
}

/** sendEmail, send_email, send-email -> ['send', 'email']. */
export const words = (s) => String(s).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()
  .split(/[^a-z0-9]+/).filter(Boolean);
const MCP_WRITE = new RegExp('^(write|edit|create|move|rename|delete|remove|append|put|update|'
  + 'patch|upload|push|replace|insert|set|save|copy|mkdir|rm|trash|unlink)$');
/** Does an MCP tool write (its first or second word is a write verb)? */
export const mcpWrites = (tool) => words(tool).slice(0, 2).some((w) => MCP_WRITE.test(w));

/** The text a file tool is about to write, for content checks. */
export function writtenText(ctx) {
  const i = ctx.input;
  if (ctx.tool === 'Write') return String(i.content ?? '');
  if (ctx.tool === 'Edit') return String(i.new_string ?? '');
  if (ctx.tool === 'MultiEdit') {
    const edits = Array.isArray(i.edits) ? i.edits : [];
    return edits.map((e) => String((e && e.new_string) ?? '')).join('\n');
  }
  if (ctx.tool === 'NotebookEdit') return String(i.new_source ?? '');
  const m = mcpName(ctx.tool);
  if (m && mcpWrites(m.tool)) {
    return ['content', 'text', 'body', 'data'].map((k) => (typeof i[k] === 'string' ? i[k] : ''))
      .join('\n');
  }
  return '';
}

/** The code of `python -c ...`, `node -e ...` and the like; null for anything else. */
export function inlineCode(argv) {
  if (!RUNTIMES.has(argv[0])) return null;
  const flags = ['-c', '-e', '-p', '--eval', '--print', '-E', '-r'];
  const i = argv.findIndex((a) => flags.includes(a) || a === 'eval');
  return i === -1 ? null : argv.slice(i + 1).join(' ');
}
export const codeWords = (code) => String(code).split(/[\s'"`(),;[\]{}+]+/).filter(Boolean);

/** Text a Bash command writes into a file: the words of echo/printf/cat and any heredoc body. */
export function shellWritten(cmd) {
  const writes = cmd.redirects.some((r) => WRITE_OPS.has(r.op) && !/^\/dev\//.test(r.target))
    || cmd.argv[0] === 'tee';
  if (!writes) return '';
  const bodies = cmd.redirects.filter((r) => r.body).map((r) => r.body);
  return [...cmd.argv.slice(1), ...bodies].join('\n');
}

/** Glob to regex for one file name: *, ?, [..]. */
export function nameGlob(n) {
  let re = '';
  for (let i = 0; i < n.length; i++) {
    const c = n[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const end = n.indexOf(']', i);
      if (end === -1) { re += '\\['; continue; }
      re += '[' + n.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
      i = end;
    } else re += c.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'i');
}

/** Minimal glob: **, *, ?, {a,b}. Matches posix relative paths. */
export function globToRegex(glob) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) { re += '\\{'; continue; }
      re += '(?:' + glob.slice(i + 1, end).split(',').map(esc).join('|') + ')';
      i = end;
    } else re += esc(c);
  }
  return new RegExp('^' + re + '$');
}

/** Does a shell word have glob characters the shell would expand (*, ?, [..], {a,b})? */
export const isGlob = (w) => /[*?[]|\{[^}]*,[^}]*\}/.test(String(w));

/**
 * A shell glob over absolute posix paths, as a regex: * and ? stay inside one path segment and do
 * not match a leading dot (like the shell without dotglob), ** crosses folders (zsh, globstar),
 * [..] and {a,b} work.
 */
export function shellGlob(pattern) {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const seg = (p) => {
    let re = '';
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      const lead = i === 0 ? '(?!\\.)' : '';
      if (c === '*') re += `${lead}[^/]*`;
      else if (c === '?') re += `${lead}[^/]`;
      else if (c === '[') {
        const end = p.indexOf(']', i + 2);
        if (end === -1) { re += '\\['; continue; }
        re += `${lead}[${p.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      } else if (c === '{') {
        const end = p.indexOf('}', i);
        if (end === -1 || !p.slice(i, end).includes(',')) { re += '\\{'; continue; }
        re += `(?:${p.slice(i + 1, end).split(',').map(seg).join('|')})`;
        i = end;
      } else re += esc(c);
    }
    return re;
  };
  const parts = String(pattern).split('/');
  const re = parts.map((p, i) => (p === '**'
    ? (i === parts.length - 1 ? '(?!\\.).*' : '(?:(?!\\.)[^/]+/)*')
    : seg(p) + (i < parts.length - 1 ? '/' : ''))).join('');
  return new RegExp(`^${re}$`);
}

/**
 * The paths an absolute glob matches on disk now (bounded walk; symlinked folders not followed).
 * Returns [] for a pattern without a literal existing prefix.
 */
export function expandGlob(abs, limit = 2000) {
  const parts = toPosix(abs).split('/');
  const cut = parts.findIndex((p) => isGlob(p));
  if (cut === -1) return [];
  const base = parts.slice(0, cut).join('/') || '/';
  const re = shellGlob(toPosix(abs));
  const deep = parts.slice(cut).some((p) => p === '**');
  const depth = parts.length - cut;
  const out = [];
  const stack = [[base, 0]];
  let seen = 0;
  while (stack.length && seen < limit) {
    const [dir, d] = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (++seen > limit) break;
      const p = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`;
      if (re.test(p)) out.push(p);
      if (e.isDirectory() && (deep || d + 1 < depth)) stack.push([p, d + 1]);
    }
  }
  return out;
}

/** Words that look like secret variable names: API_KEY, GITHUB_TOKEN, DB_PASSWORD. */
export const SECRET_VAR = /^\w*(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE)\w*$/i;
