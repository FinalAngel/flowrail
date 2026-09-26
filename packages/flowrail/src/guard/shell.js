// Shell command parser for red-line matching.
//
// A red line like "ask before git push" should hold `sudo git push`, `git -C . push`,
// `bash -lc 'git push'`, `\git pu\sh` and `cd x && git push`, but not
// `git commit -m "push the fix"` or a commit message in a heredoc. commands() splits a command
// line into simple commands, each as { argv, redirects }, with wrappers, env assignments, binary
// paths and git global options removed, and with `sh -c '...'`, `eval`, `find -exec`, inline
// scripts (python -c, perl -e, awk) and scripts piped into a shell unwrapped.
//
// This is a pragmatic lexer, not a POSIX shell. Aliases, functions, variables used as the binary
// ($GIT push) and scripts on disk are out of reach. A red line is a seatbelt, not a jail (see
// SECURITY.md).

const WRAPPERS = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '--user', '--group'],
  doas: ['-u', '-C'],
  command: [],
  builtin: [],
  exec: ['-a'],
  env: ['-u', '-C', '--unset', '--chdir'],
  nohup: [],
  time: [],
  nice: ['-n'],
  ionice: ['-c', '-n', '-p'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e'],
  xargs: ['-I', '-n', '-L', '-P', '-d', '-E', '-s', '-a', '--max-args', '--max-procs'],
  watch: ['-n', '-d'],
  unbuffer: [],
  caffeinate: ['-t', '-w'],
  chronic: [],
  xcrun: ['-sdk', '--sdk', '-toolchain', '--toolchain', '-log'],
  arch: ['-d', '-e'],
  script: ['-t', '-T', '-I', '-O', '-B', '-E', '-m', '--timing', '--log-io', '--log-in',
    '--log-out', '--log-timing', '--echo', '--logging-format'],
};
const POSITIONAL_AFTER_OPTS = { timeout: 1, script: 1 };
/** Wrapper options whose value is a command line: script -c 'git push'. */
const COMMAND_OPTS = { script: ['-c', '--command'] };
const KEYWORDS = new Set(['{', '}', '!', 'if', 'then', 'else', 'elif', 'fi', 'do', 'done',
  'while', 'until']);
export const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash']);
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace',
  '--exec-path', '--config-env', '--super-prefix']);
const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_DEPTH = 6;
const RUNTIMES = new Set(['python', 'python3', 'node', 'deno', 'bun', 'ruby', 'perl', 'php']);
const AWKS = new Set(['awk', 'gawk', 'mawk', 'nawk']);
const INLINE_FLAGS = new Set(['-c', '-e', '-p', '--eval', '--print', '-E', '-r', 'eval']);
const WHICH = new RegExp('^\\$\\((?:which|command -v|type -p|type -P) ([\\w.-]+)\\)$'
  + '|^`(?:which|command -v) ([\\w.-]+)`$');
const BREAK = new Set([' ', '\t', ';', '&', '|', '\n', '\r', '(', ')', '<', '>']);
const IFS = /\$\{IFS\}|\$IFS(?![\w])/;
const IFS_ALL = new RegExp(IFS.source, 'g');

/**
 * Lex a command line. Returns simple commands ({argv, redirects, sep}) in order, plus the source
 * text of every command substitution ($(...), `...`, <(...)) so the caller can check those too.
 * A heredoc body is attached to its redirect ({op:'<<', target:'EOF', body}) instead of being
 * lexed as commands.
 */
export function lex(input) {
  const src = String(input).replace(/\\\r?\n/g, '');
  const { cmds, subs } = scan(src, 0, false);
  return { commands: cmds, subs };
}

/** $'...' (ANSI-C quoting) from index j; returns [text, index of the closing quote]. */
function ansiC(src, j) {
  let buf = '';
  while (j < src.length && src[j] !== "'") {
    if (src[j] === '\\' && j + 1 < src.length) {
      const e = src[j + 1];
      const hex = src.slice(j + 2, j + 4);
      if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(hex)) {
        buf += String.fromCharCode(parseInt(hex, 16));
        j += 4;
        continue;
      }
      buf += { n: '\n', t: '\t', r: '\r' }[e] ?? e;
      j += 2;
      continue;
    }
    buf += src[j++];
  }
  return [buf, j];
}

function scan(src, start, nested) {
  const cmds = [];
  const subs = [];
  let cur = { argv: [], redirects: [] };
  let word = null;
  let target = null; // a redirect waiting for its target word
  let pending = []; // heredocs waiting for their body after the next newline
  let depth = 0;
  const add = (s) => { word = (word ?? '') + s; };
  const endWord = () => {
    if (word === null) return;
    if (target) { target.target = word; target = null; } else cur.argv.push(word);
    word = null;
  };
  const endCmd = (sep) => {
    endWord();
    if (cur.argv.length || cur.redirects.length) { cur.sep = sep; cmds.push(cur); }
    cur = { argv: [], redirects: [] };
  };
  // "$(" or "<(" at i: scan the inside as a command line of its own; returns the index of ")".
  const substitution = (i) => {
    const inner = scan(src, i + 2, true);
    subs.push(src.slice(i + 2, inner.end));
    return inner.end;
  };

  let i = start;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { add(src[i + 1] ?? ''); i++; continue; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end === -1 ? src.length : end;
      add(src.slice(i + 1, stop));
      i = stop;
      continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      const [text, j] = ansiC(src, i + 2);
      add(text);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && '$`"\\'.includes(src[j + 1])) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '$' && src[j + 1] === '(') {
          const close = substitution(j);
          buf += src.slice(j, close + 1);
          j = close + 1;
          continue;
        }
        if (src[j] === '`') {
          const close = src.indexOf('`', j + 1);
          const stop = close === -1 ? src.length : close;
          subs.push(src.slice(j + 1, stop));
          j = stop + 1;
          continue;
        }
        buf += src[j++];
      }
      add(buf);
      i = j;
      continue;
    }
    if ((c === '$' || c === '<' || c === '>') && src[i + 1] === '(') {
      const close = substitution(i);
      // $(...) and <(...) stay words: `bash <(echo git push)` runs what the substitution prints.
      add(c === '>' ? '' : src.slice(i, close + 1));
      i = close;
      continue;
    }
    if (c === '`') {
      const close = src.indexOf('`', i + 1);
      const stop = close === -1 ? src.length : close;
      subs.push(src.slice(i + 1, stop));
      add(src.slice(i, stop + 1)); // kept as a word, like $(...): `echo git` push is not "push"
      i = stop;
      continue;
    }
    if (c === '>' || c === '<' || (c === '&' && src[i + 1] === '>')) {
      // "2>file": the digits are a file descriptor, not a word.
      if (word !== null && /^\d+$/.test(word)) word = null;
      endWord();
      const op = src.slice(i).match(/^(&>>|&>|<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/)[0];
      i += op.length - 1;
      const r = { op: op === '<<-' ? '<<' : op, target: '' };
      cur.redirects.push(r);
      if (op === '<<' || op === '<<-') {
        // Read the delimiter now; the body starts after the next newline.
        let j = i + 1;
        while (src[j] === ' ' || src[j] === '\t') j++;
        let delim = '';
        while (j < src.length && !BREAK.has(src[j])) delim += src[j++];
        r.target = delim.replace(/["'\\]/g, '');
        r.strip = op === '<<-';
        pending.push(r);
        i = j - 1;
      } else {
        target = r;
      }
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '#' && word === null) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl - 1;
      continue;
    }
    if (c === '(') { depth++; endCmd(';'); continue; }
    if (c === ')') {
      if (nested && depth === 0) { endCmd(';'); return { cmds, subs, end: i }; }
      depth = Math.max(0, depth - 1);
      endCmd(';');
      continue;
    }
    if (c === '\n' || c === '\r') {
      endCmd(';');
      if (pending.length) i = readHeredocs(src, i + 1, pending) - 1;
      pending = [];
      continue;
    }
    if (c === '|') {
      if (src[i + 1] === '|') {
        endCmd('||');
        i++;
      } else {
        endCmd('|');
        if (src[i + 1] === '&') i++;
      }
      continue;
    }
    if (c === '&') {
      if (src[i + 1] === '&') i++;
      endCmd(';');
      continue;
    }
    if (c === ';') { endCmd(';'); continue; }
    add(c);
  }
  endCmd(';');
  return { cmds, subs, end: i };
}

/** Attach heredoc bodies starting at `pos`; returns the index after the last delimiter line. */
function readHeredocs(src, pos, pending) {
  for (const r of pending) {
    const body = [];
    while (pos < src.length) {
      const nl = src.indexOf('\n', pos);
      const line = src.slice(pos, nl === -1 ? src.length : nl);
      pos = nl === -1 ? src.length : nl + 1;
      if ((r.strip ? line.replace(/^\t+/, '') : line).replace(/\r$/, '') === r.target) break;
      body.push(line);
    }
    r.body = body.join('\n');
  }
  return pos;
}

const basename = (w) => w.replace(/^\\/, '').split('/').pop();

function quote(w) {
  if (w && !/[\s"'\\]/.test(w)) return w;
  return JSON.stringify(w);
}

const PAIRS = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** Perl's quote-like strings: q(...), qq{...}, qx/.../ and friends. */
function perlQuotes(code) {
  const out = [];
  for (const m of String(code).matchAll(/\bq[qxw]?\s*([^\w\s])/g)) {
    const close = PAIRS[m[1]] || m[1];
    const from = m.index + m[0].length;
    const end = code.indexOf(close, from);
    if (end !== -1) out.push(code.slice(from, end));
  }
  return out;
}

/**
 * Shell commands hidden in an inline script: every string literal, every list of literals
 * joined, and Perl's q(...) strings.
 */
export function scriptCommands(code) {
  const out = [];
  const lit = /'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g;
  for (const m of String(code).matchAll(lit)) out.push(m[1] ?? m[2] ?? m[3]);
  for (const m of String(code).matchAll(/\[([^[\]]*)\]/g)) {
    const words = [...m[1].matchAll(lit)].map((x) => x[1] ?? x[2] ?? x[3]);
    if (words.length > 1) out.push(words.map(quote).join(' '));
  }
  out.push(...perlQuotes(String(code)));
  return out.filter((x) => /\s/.test(x));
}

const stdinScript = (redirects) => redirects
  .filter((r) => (r.op === '<<' && r.body) || r.op === '<<<')
  .map((r) => r.body ?? r.target);

function isBareShell(argv) {
  const t = argv.slice();
  while (t.length && (ENV_ASSIGN.test(t[0]) || WRAPPERS[basename(t[0])])) t.shift();
  return t.length > 0 && SHELLS.has(basename(t[0]))
    && t.slice(1).every((w) => /^[-+]/.test(w) && !/^-[a-zA-Z]*c/.test(w));
}

/** The program text of an awk call: its first operand that is not an option. */
function awkProgram(t) {
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '-f') return null;
    if (t[i] === '-F' || t[i] === '-v') { i++; continue; }
    if (t[i].startsWith('-')) continue;
    return t[i];
  }
  return null;
}

/**
 * Remove git's global options from argv (in place). `-c key=value` and `--config-env` values
 * are returned so the guard can see configuration that runs programs; `-c alias.x=...` and
 * `git config alias.x ...` are expanded so the red lines see what the alias runs.
 */
function gitOptions(t, depth, out) {
  const aliases = {};
  const config = [];
  while (t.length > 1 && t[1].startsWith('-')) {
    const opt = t[1];
    const takesArg = GIT_ARG_OPTS.has(opt) && !opt.includes('=');
    let val = null;
    if (opt === '-c' || opt === '--config-env') val = t[2];
    else if (opt.startsWith('-c') && opt.length > 2) val = opt.slice(2);
    else if (opt.startsWith('--config-env=')) val = opt.slice('--config-env='.length);
    if (typeof val === 'string') config.push(val);
    const alias = opt.startsWith('-c') && /^alias\.([^=]+)=(.*)$/is.exec(val || '');
    if (alias) aliases[alias[1].toLowerCase()] = alias[2];
    t.splice(1, takesArg ? 2 : 1);
  }
  const a = t[1] && aliases[t[1].toLowerCase()];
  if (a !== undefined) {
    if (a.startsWith('!')) collect(`${a.slice(1)} ${t.slice(2).join(' ')}`, depth + 1, out);
    else collect(`git ${a} ${t.slice(2).map(quote).join(' ')}`, depth + 1, out);
  }
  // git config alias.p push: a push by another name later on.
  const cfg = t[1] === 'config' ? t.slice(2).filter((w) => !w.startsWith('-')) : [];
  if (cfg[0] === 'set') cfg.shift();
  if (/^alias\./i.test(cfg[0] || '') && cfg[1] !== undefined) {
    const v = cfg.slice(1).join(' ');
    collect(v.startsWith('!') ? v.slice(1) : `git ${v}`, depth + 1, out);
  }
  return config;
}

/** Strip wrappers; unwrap shells, eval and find -exec. Pushes simple commands onto `out`. */
function simplify(cmd, depth, out, next) {
  const t = cmd.argv.slice();
  const stripped = [];
  const assigns = [];
  for (let guard = 0; guard < 20; guard++) {
    while (t.length && (KEYWORDS.has(t[0]) || ENV_ASSIGN.test(t[0]))) {
      if (ENV_ASSIGN.test(t[0])) assigns.push(t[0]);
      t.shift();
    }
    if (!t.length) break;
    const bin = basename(t[0]);
    const argOpts = WRAPPERS[bin];
    if (!argOpts) break;
    stripped.push(bin);
    t.shift();
    while (t.length && t[0].startsWith('-') && t[0] !== '-') {
      const opt = t.shift();
      if (opt === '--') break;
      if ((COMMAND_OPTS[bin] || []).includes(opt)) {
        if (t[0] !== undefined) collect(t.shift(), depth + 1, out);
      } else if (argOpts.includes(opt)) t.shift();
    }
    for (let n = POSITIONAL_AFTER_OPTS[bin] || 0; n > 0; n--) t.shift();
  }
  const base = { redirects: cmd.redirects, sep: cmd.sep, ...(assigns.length ? { assigns } : {}) };
  if (!t.length) {
    // A bare `env` prints the environment: keep it as a command of its own.
    if (stripped.at(-1) === 'env') out.push({ ...base, argv: ['env'] });
    else if (cmd.redirects.length || assigns.length) out.push({ ...base, argv: [] });
    return;
  }
  // git${IFS}push: the shell splits it into words when it runs.
  if (t.some((w) => IFS.test(w))) {
    collect(t.map((w) => w.replace(IFS_ALL, ' ')).join(' '), depth + 1, out);
  }
  const which = WHICH.exec(t[0]);
  if (which) t[0] = which[1] || which[2];
  const bin = basename(t[0]);
  // ./run.sh keeps its path, so a matcher can read the script it runs.
  const extra = {
    ...(stripped.includes('xargs') ? { xargs: true } : {}),
    ...(t[0].includes('/') ? { path: t[0].replace(/^\\/, '') } : {}),
  };
  t[0] = bin;

  // python -c "os.system('git push')", node -e "execSync('git push')": the string literals in
  // an inline script are checked as commands too, and so is each ['git', 'push'] style list.
  if (RUNTIMES.has(bin.replace(/[\d.]+$/, '')) || RUNTIMES.has(bin)) {
    const i = t.findIndex((w, k) => k > 0 && INLINE_FLAGS.has(w));
    if (i !== -1 && t[i + 1] !== undefined) {
      for (const text of scriptCommands(t.slice(i + 1).join(' '))) collect(text, depth + 1, out);
    }
  }
  // awk 'BEGIN { system("git push") }'
  if (AWKS.has(bin)) {
    const prog = awkProgram(t);
    if (prog) for (const text of scriptCommands(prog)) collect(text, depth + 1, out);
  }

  if (SHELLS.has(bin) || bin === 'su') {
    for (let i = 1; i < t.length; i++) {
      const w = t[i];
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(w) || w === '--command') {
        if (t[i + 1] !== undefined) collect(t[i + 1], depth + 1, out);
        return;
      }
      if (bin === 'su' || w.startsWith('-') || w.startsWith('+')) continue;
      break;
    }
    // bash <<EOF ... EOF and bash <<< "...": the body is the script.
    if (isBareShell(t)) for (const s of stdinScript(cmd.redirects)) collect(s, depth + 1, out);
  }
  // bash <(echo 'git push'), source <(printf ...): what the substitution prints is the script.
  if (SHELLS.has(bin) || bin === 'source' || bin === '.') {
    for (const w of t.slice(1)) {
      if (!/^<\(.*\)$/s.test(w)) continue;
      const inner = lex(w.slice(2, -1)).commands;
      for (const c of inner) printed(c, depth, out);
    }
  }
  if (bin === 'eval') {
    collect(t.slice(1).join(' '), depth + 1, out);
    return;
  }
  if (bin === 'git') {
    const config = gitOptions(t, depth, out);
    if (config.length) extra.gitConfig = config;
  }
  if (bin === 'find') {
    for (let i = 1; i < t.length; i++) {
      if (!['-exec', '-execdir', '-ok', '-okdir'].includes(t[i])) continue;
      let j = i + 1;
      while (j < t.length && t[j] !== ';' && t[j] !== '+') j++;
      if (j > i + 1) simplify({ argv: t.slice(i + 1, j), redirects: [] }, depth + 1, out);
      i = j;
    }
  }
  // echo 'git push' | sh, cat <<EOF | bash: what is piped into a bare shell runs.
  if (cmd.sep === '|' && next && isBareShell(next.argv)) printed({ ...cmd, argv: t }, depth, out);
  out.push({ ...base, argv: t, ...extra });
}

/** What echo, printf or a heredoc prints, collected as a script (it is about to be run). */
function printed(cmd, depth, out) {
  const bin = basename(cmd.argv[0] || '');
  if (bin === 'echo' || bin === 'printf') {
    const text = cmd.argv.slice(1).filter((w) => !/^-[neE]+$/.test(w)).join(' ');
    collect(text.replace(/\\n/g, '\n'), depth + 1, out);
  }
  for (const s of stdinScript(cmd.redirects)) collect(s, depth + 1, out);
}

function collect(input, depth, out) {
  if (depth > MAX_DEPTH) return;
  const { commands: cmds, subs } = lex(input);
  cmds.forEach((cmd, i) => simplify(cmd, depth, out, cmds[i + 1]));
  for (const sub of subs) collect(sub, depth + 1, out);
}

/**
 * Parse a command line into canonical simple commands.
 * commands('cd x && sudo /usr/bin/git -C . push origin') ->
 *   [{argv:['cd','x'], redirects:[]}, {argv:['git','push','origin'], redirects:[]}]
 * Extra fields when they apply: sep ('|' when piped into the next command), assigns (VAR=value
 * words before the program), gitConfig (git -c key=value), path (./run.sh), xargs.
 * @param {string} command
 * @returns {{argv: string[], redirects: {op: string, target: string, body?: string}[]}[]}
 */
export function commands(command) {
  const out = [];
  collect(String(command ?? ''), 0, out);
  return out;
}

/** One simple command as a canonical string: what regex red lines match against. */
export function render(cmd) {
  const redirs = cmd.redirects.filter((r) => r.op !== '<<')
    .map((r) => `${r.op} ${quote(r.target)}`);
  return [...cmd.argv.map(quote), ...redirs].join(' ');
}

/**
 * Normalize a shell command line into canonical simple commands (strings).
 * normalize('cd x && sudo /usr/bin/git -C . push origin main') -> ['cd x', 'git push origin main']
 * @param {string} command
 * @returns {string[]}
 */
export function normalize(command) {
  return commands(command).map(render);
}
