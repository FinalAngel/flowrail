// secret-files: secret files, secrets written into files, and secrets printed into the session
// (the environment, $API_KEY, `gh auth token`). Part of the vendored guard.
import path from 'node:path';
import {
  hold, positionals, toPosix, eachCommand, strongest, inputPaths, mcpName, mcpWrites, writtenText,
  inlineCode, codeWords, shellWritten, nameGlob, resolveWord, realPath, trackLink, FILE_WRITE_TOOLS,
  WRITE_OPS, SECRET_VAR,
} from './common.js';

const SAMPLE_SECRETS = ['.env', '.env.local', '.envrc', 'prod.env', 'id_rsa', 'id_ed25519',
  'server.pem', 'tls.key', 'cert.p12', 'service-account.json', 'kubeconfig', '.npmrc', '.netrc',
  'credentials'];

/** A glob like .e* or *.pem that would match a secret file. Plain *, ** and *.* do not count. */
function globHitsSecret(n) {
  if (!/[*?[]/.test(n) || /^\*+(\.\*)?$/.test(n)) return false;
  try {
    const rx = nameGlob(n);
    const dot = n.startsWith('.');
    return SAMPLE_SECRETS.some((s) => (s.startsWith('.') === dot || !s.startsWith('.'))
      && rx.test(s));
  } catch { return false; }
}

/** Does this file name look like a secret? Case-insensitive; .env.example and the like are fine. */
export function isSecretName(p) {
  const n = path.posix.basename(toPosix(p).replace(/^[\w./-]*:(?=[^/])/, '')).toLowerCase();
  if (globHitsSecret(n)) return true;
  if (!n || /\.(example|sample|template|pub)$/.test(n)) return false;
  return /^\.env(\..+)?$/.test(n) || n === '.envrc' || /\.env$/.test(n)
    || /^id_(rsa|dsa|ecdsa|ed25519)/.test(n) || /\.(pem|key|p12|pfx|jks|keystore)$/.test(n)
    || /^service-account.*\.json$/.test(n) || n.startsWith('kubeconfig')
    || ['.npmrc', '.netrc', '.pgpass', 'credentials', 'environ'].includes(n);
}

/** High-confidence secret formats. A key ending in EXAMPLE (AWS's documented sample) is fine. */
export const SECRET_PATTERNS = [
  { name: 'an AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'a GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { name: 'a Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}/ },
  { name: 'a Stripe live key', re: /\b[sr]k_live_[0-9A-Za-z]{20,}/ },
  { name: 'an Anthropic or OpenAI API key', re: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'a Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'a private key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
];

/** The name of the first secret found in `text`, or null. */
export function findSecret(text) {
  const t = String(text || '');
  if (!t) return null;
  for (const { name, re } of SECRET_PATTERNS) {
    const m = re.exec(t);
    if (m && !/EXAMPLE$/.test(m[0])) return name;
  }
  return null;
}

const READERS = new Set(('cat less more head tail grep egrep fgrep rg ag ack source . base64 xxd '
  + 'od hexdump strings awk gawk sort uniq diff nl bat batcat tac wc cut jq yq vi vim nvim nano '
  + 'emacs code open pbcopy curl scp rsync ln zip tar gpg openssl dotenv').split(' '));
const COPIERS = new Set(['cp', 'mv', 'install', 'rsync', 'scp', 'ln']);
const GREPS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);
const argValues = (argv) => argv
  .flatMap((a) => (a.includes('=') ? [a, a.slice(a.indexOf('=') + 1)] : [a]));

/** env, printenv, set, export -p: print every environment variable, secrets included. */
function envDump(argv) {
  if (['env', 'printenv', 'set'].includes(argv[0]) && argv.length === 1) return true;
  return ['export', 'declare', 'typeset'].includes(argv[0]) && argv.length > 1
    && argv.slice(1).every((a) => /^-[a-zA-Z]*[px]/.test(a));
}

/** `env | grep NODE_ENV` shows one variable: fine, unless the pattern looks like a secret. */
function filteredDump(next) {
  if (!next || !GREPS.has(next.argv[0])) return false;
  const pattern = positionals(next.argv.slice(1))[0];
  return !!pattern && !/key|token|secret|pass|cred|auth|private/i.test(pattern);
}

/** $OPENAI_API_KEY in echo/printf/printenv: the value lands in the session. */
function printsSecretVar(argv) {
  const [bin, ...args] = argv;
  if (bin === 'printenv') return args.find((a) => SECRET_VAR.test(a)) || null;
  if (!['echo', 'printf', 'print'].includes(bin)) return null;
  for (const a of args) {
    for (const m of a.matchAll(/\$\{?([A-Za-z_]\w*)/g)) {
      if (SECRET_VAR.test(m[1])) return `$${m[1]}`;
    }
  }
  return null;
}

/** os.environ, process.env, %ENV printed whole, or a secret-looking variable read by name. */
function scriptEnv(code) {
  const dump = /(\bos\.environ|\bprocess\.env|%ENV|\bENV)\b(?!\s*(\[|\.get\b|\.\w|\{|\.fetch))/;
  if (dump.test(code)) return 'printing every environment variable';
  const named = /(environ|env|ENV)\s*(\[|\.get\(|\.|\{|\.fetch\()\s*['"]?([A-Za-z_]\w*)/g;
  for (const m of code.matchAll(named)) if (SECRET_VAR.test(m[3])) return `reading ${m[3]}`;
  return null;
}

/** CLIs whose job is to print a credential. */
function credentialCli(argv) {
  const [bin, a1, a2] = argv;
  const pos = positionals(argv.slice(1));
  const any = (...w) => w.some((x) => argv.includes(x));
  if (bin === 'gh' && a1 === 'auth' && (a2 === 'token' || any('--show-token', '-t'))) {
    return 'gh auth token';
  }
  if (bin === 'security' && /^(find-(generic|internet)-password|dump-keychain)$/.test(a1 || '')) {
    if (a1 === 'dump-keychain' || any('-w', '-g')) return `security ${a1}`;
  }
  const reveal = pos[0] === 'item' && pos[1] === 'get' && any('--reveal');
  if (bin === 'op' && (a1 === 'read' || reveal)) {
    return `op ${a1}`;
  }
  if (bin === 'aws' && pos[0] === 'configure' && ['get', 'export-credentials'].includes(pos[1])) {
    return `aws configure ${pos[1]}`;
  }
  const token = /^print-(access|identity|refresh)-token$/.test(pos[1] || '');
  if (bin === 'gcloud' && pos[0] === 'auth' && token) {
    return `gcloud auth ${pos[1]}`;
  }
  if (bin === 'az' && pos[0] === 'account' && pos[1] === 'get-access-token') {
    return 'az account get-access-token';
  }
  if (bin === 'heroku' && a1 === 'auth:token') return 'heroku auth:token';
  if (bin === 'git' && a1 === 'credential' && a2 === 'fill') return 'git credential fill';
  if (bin === 'vault' && (['read'].includes(a1) || (a1 === 'kv' && a2 === 'get'))) {
    return `vault ${a1}`;
  }
  if (bin === 'doppler' && a1 === 'secrets') return 'doppler secrets';
  return null;
}

/**
 * A secret by its name, or through a symlink to one (ln -s .env envlink; cat envlink). `links`
 * are the links made earlier on the same command line.
 */
function secretPath(word, cwd, links = {}) {
  if (isSecretName(word)) return true;
  const abs = cwd && resolveWord(word, cwd);
  return !!abs && isSecretName(realPath(abs, { follow: true, links }));
}

function fileTool(ctx) {
  const secret = findSecret(writtenText(ctx));
  if (secret) return hold('block', `${secret} in the written text`);
  const mcp = mcpName(ctx.tool);
  const reads = ctx.tool === 'Read' || ctx.tool === 'Grep';
  const files = FILE_WRITE_TOOLS.has(ctx.tool) || reads || mcp ? inputPaths(ctx.input) : [];
  if (ctx.tool === 'Grep' && typeof ctx.input.glob === 'string') files.push(ctx.input.glob);
  const file = files.find((f) => secretPath(f, ctx.cwd || ctx.root));
  if (!file) return null;
  const name = path.posix.basename(toPosix(file));
  if (FILE_WRITE_TOOLS.has(ctx.tool) || (mcp && mcpWrites(mcp.tool))) {
    return hold('block', `writing ${name}`);
  }
  return hold('ask', `reading ${name}`);
}

function secretArgs(bin, args, secrets) {
  const pos = positionals(args);
  const first = secrets[0];
  if (['tee', 'truncate', 'dd', 'shred'].includes(bin)) return hold('block', `writing ${first}`);
  const inPlace = args.some((a) => /^-i|^--in-place/.test(a) || /^-[a-zA-Z]*i/.test(a));
  if (['sed', 'perl', 'ruby'].includes(bin) && inPlace) return hold('block', `editing ${first}`);
  if (bin === 'git' && args[0] === 'add') return hold('block', `git add ${first}`);
  if (bin === 'git' && ['show', 'diff', 'cat-file', 'blame', 'log', 'grep'].includes(args[0])) {
    return hold('ask', `reading ${first}`);
  }
  const dest = pos[pos.length - 1];
  // cp .env.example .env makes the file from its template; the secrets go in later (Write, held).
  const fromTemplate = pos.slice(0, -1).every((f) => /\.(example|sample|template|dist)$/i.test(f));
  if (['cp', 'install'].includes(bin) && pos.length >= 2 && fromTemplate) return null;
  if (COPIERS.has(bin) && pos.length >= 2 && isSecretName(dest) && bin !== 'ln') {
    return hold('block', `writing ${dest}`);
  }
  if (COPIERS.has(bin) || READERS.has(bin) || bin === 'sed') return hold('ask', `reading ${first}`);
  return null;
}

export function secretFiles(ctx) {
  if (ctx.tool !== 'Bash') return fileTool(ctx);
  const found = [];
  const links = {};
  eachCommand(ctx, (cmd, cwd, i) => {
    const { argv, redirects } = cmd;
    const secretWord = (w) => secretPath(w, cwd, links);
    for (const r of redirects) {
      if (!secretWord(r.target)) continue;
      if (WRITE_OPS.has(r.op)) found.push(hold('block', `writing ${r.target}`));
      else if (r.op === '<') found.push(hold('ask', `reading ${r.target}`));
    }
    const secret = findSecret(shellWritten(cmd));
    if (secret) found.push(hold('block', `${secret} written to a file`));
    const bin = argv[0];
    if (!bin) return null;
    if (envDump(argv) && !(cmd.sep === '|' && filteredDump(ctx.cmds[i + 1]))) {
      found.push(hold('ask', 'printing every environment variable'));
    }
    const v = printsSecretVar(argv);
    if (v) found.push(hold('ask', `printing ${v}`));
    const cred = credentialCli(argv);
    if (cred) found.push(hold('ask', `printing a credential (${cred})`));
    const code = inlineCode(argv);
    if (code !== null) {
      // No glob matching here: in code, .*? is a regex, not a shell glob that could reach .env.
      if (codeWords(code).some((w) => !/[*?[]/.test(w) && isSecretName(w))) {
        found.push(hold('ask', 'a script touching a secret file'));
      }
      const env = scriptEnv(code);
      if (env) found.push(hold('ask', `a script ${env}`));
    }
    const args = argv.slice(1);
    const secrets = argValues(args).filter((a) => !a.startsWith('-') && secretWord(a));
    if (secrets.length) found.push(secretArgs(bin, args, secrets));
    trackLink(argv, cwd, links);
    return null;
  });
  return strongest(found);
}
