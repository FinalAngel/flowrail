// git-push and git-destructive, plus the git configuration that runs programs (used by the
// flowrail-tamper floor). Part of the vendored guard.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commands } from '../shell.js';
import { hold, has, shortFlags, positionals, mcpName, words } from './common.js';

const REMOTE_PUSH = [['git', 'push'], ['git', 'send-pack'], ['hub', 'push'], ['gh', 'repo', 'sync'],
  ['git', 'subtree', 'push'], ['jj', 'git', 'push'], ['git-push']];
const DYNAMIC = /[$`]/;

/** Aliases from the repo's .git/config and ~/.gitconfig: { name: expansion }. */
function gitAliases(root) {
  const out = {};
  for (const file of [path.join(os.homedir(), '.gitconfig'), path.join(root, '.git', 'config')]) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let inAlias = false;
    for (const line of text.split('\n')) {
      const sec = /^\s*\[([^\]]+)\]/.exec(line);
      if (sec) { inAlias = /^alias$/i.test(sec[1].trim()); continue; }
      const kv = inAlias && /^\s*([\w.-]+)\s*=\s*(.*)$/.exec(line);
      if (kv) out[kv[1].toLowerCase()] = kv[2].trim().replace(/^"(.*)"$/, '$1');
    }
  }
  return out;
}

const GIT_BUILTIN = new Set(('add am annotate apply archive bisect blame branch bundle cat-file '
  + 'check-ignore checkout cherry cherry-pick clean clone commit config count-objects describe '
  + 'diff difftool fetch format-patch fsck gc grep help init log ls-files ls-remote ls-tree merge '
  + 'merge-base mergetool mv notes pull push range-diff rebase reflog remote repack replace reset '
  + 'restore rev-list rev-parse revert rm shortlog show show-ref sparse-checkout stash status '
  + 'submodule switch tag update-index update-ref var verify-commit whatchanged worktree '
  + 'filter-branch filter-repo send-pack subtree lfs').split(' '));

/** Expand a repo or user git alias (git p -> git push) so the matchers see what runs. */
function expandAlias(argv, ctx) {
  if (argv[0] !== 'git' || !argv[1] || GIT_BUILTIN.has(argv[1]) || argv[1].startsWith('-')) {
    return null;
  }
  if (ctx.aliasDepth > 3) return null;
  if (!ctx.aliases) ctx.aliases = gitAliases(ctx.root);
  const a = ctx.aliases[argv[1].toLowerCase()];
  if (a === undefined) return null;
  ctx.aliasDepth = (ctx.aliasDepth || 0) + 1;
  const rest = argv.slice(2).join(' ');
  return commands(a.startsWith('!') ? `${a.slice(1)} ${rest}` : `git ${a} ${rest}`);
}

/** git with its subcommand coming from a pipe (xargs) or a variable: we cannot see what runs. */
function unknownGit(cmd, verb) {
  const [bin, sub] = cmd.argv;
  if (bin === 'git' && cmd.xargs && (!sub || sub.startsWith('-') || sub.includes('{'))) {
    return hold('ask', `git with its arguments from a pipe (xargs); cannot tell if it ${verb}`);
  }
  if (bin === 'git' && sub && DYNAMIC.test(sub)) {
    return hold('ask', `git with its subcommand in a variable; cannot tell if it ${verb}`);
  }
  const word = verb === 'pushes' ? 'push' : 'reset';
  if (bin && DYNAMIC.test(bin) && cmd.argv.slice(1).includes(word)) {
    return hold('ask', `a program named by a variable, then "${cmd.argv[1]}"`);
  }
  return null;
}

/**
 * Does argv carry one of these long options, spelled out or abbreviated? git accepts any
 * unambiguous prefix (--har is --hard, --forc is --force), so any prefix counts: an ambiguous one
 * makes git refuse to run, which is no loss.
 */
const longOpt = (args, ...names) => args.some((a) => {
  if (!a.startsWith('--') || a === '--') return false;
  const k = a.slice(2).split('=')[0];
  return k.length > 0 && names.some((n) => n.startsWith(k));
});

// Repository writes on a git host's MCP server: a push by another name.
const HOST = /github|gitlab|bitbucket|gitea|forgejo/i;
const REPO_OBJECT = /^(files?|branch(es)?|commits?|refs?|tags?|contents?|trees?)$/;

/** mcp__github__create_or_update_file, push_files, delete_file, create_branch, merge_*. */
export function mcpRepoWrite(tool) {
  const m = mcpName(tool);
  if (!m || !HOST.test(m.server)) return null;
  const w = words(m.tool);
  if (/^(get|list|search|read|fetch|find|query|describe|show|view|check|download)$/.test(w[0])) {
    return null;
  }
  const writes = w.some((x) => ['push', 'merge'].includes(x))
    || (/^(create|update|delete|put|upsert|commit)$/.test(w[0])
      && w.some((x) => REPO_OBJECT.test(x)));
  return writes ? `${m.server}: ${m.tool}` : null;
}

const GH_VALUE = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field',
  '--input', '-q', '--jq', '-t', '--template', '--hostname', '--cache', '-p', '--preview']);

/** `gh api -X PATCH repos/o/r/git/refs/heads/main -f force=true`: { method, force } or null. */
function ghRefWrite(argv) {
  if (argv[0] !== 'gh' || argv[1] !== 'api') return null;
  let method = null;
  let endpoint = null;
  let fields = false;
  let force = false;
  const args = argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf('=');
    const long = a.startsWith('--') && eq !== -1;
    const name = long ? a.slice(0, eq) : /^-X./.test(a) ? '-X' : a;
    let inline = null;
    if (long) inline = a.slice(eq + 1);
    else if (name === '-X' && a !== '-X') inline = a.slice(2);
    if (GH_VALUE.has(name)) {
      const v = inline ?? args[++i] ?? '';
      if (name === '-X' || name === '--method') method = v.toUpperCase();
      if (['-f', '--raw-field', '-F', '--field', '--input'].includes(name)) fields = true;
      if (/^force=(true|1)$/i.test(v) || name === '--input') force = true;
      continue;
    }
    if (!a.startsWith('-') && endpoint === null) endpoint = a;
  }
  if (!endpoint || !/(^|\/)git\/refs(\/|$)/.test(endpoint)) return null;
  method = method || (fields ? 'POST' : 'GET');
  return method === 'GET' ? null : { method, force };
}

/** git push --dry-run / -n sends nothing. */
const dryRun = (args) => has(args, '--dry-run') || /n/.test(shortFlags(args));

export function gitPush(ctx) {
  const repo = mcpRepoWrite(ctx.tool);
  if (repo) return hold('block', repo);
  if (ctx.tool !== 'Bash') return null;
  const check = (list) => {
    for (const cmd of list) {
      for (const seq of REMOTE_PUSH) {
        if (!seq.every((w, i) => cmd.argv[i] === w)) continue;
        if (seq[1] === 'push' && seq.length === 2 && dryRun(cmd.argv.slice(2))) continue;
        return hold('block', seq.join(' '));
      }
      if (ghRefWrite(cmd.argv)) return hold('block', 'gh api writing a git ref');
      const expanded = expandAlias(cmd.argv, ctx);
      if (expanded) {
        const r = check(expanded);
        if (r) return r;
      }
      const u = unknownGit(cmd, 'pushes');
      if (u) return u;
    }
    return null;
  };
  return check(ctx.cmds);
}

const ALL = ['.', ':/', '*', ':/*'];

function gitPushArgs(args, short, pos) {
  if (dryRun(args)) return null;
  if (longOpt(args, 'force', 'mirror') || /f/.test(short) || pos.some((r) => r.startsWith('+'))) {
    return hold('block', 'force push');
  }
  // --force-with-lease only overwrites what this clone last saw there: asked, not blocked.
  if (longOpt(args, 'force-with-lease', 'force-if-includes')) {
    return hold('ask', 'force push with lease');
  }
  const del = longOpt(args, 'delete', 'prune') || /d/.test(short);
  if (del || pos.slice(1).some((r) => r.startsWith(':'))) {
    return hold('ask', 'deleting a remote branch');
  }
  return null;
}

function gitDestructiveArgv(argv) {
  const ref = ghRefWrite(argv);
  if (ref && ref.method === 'DELETE') return hold('ask', 'deleting a remote ref (gh api)');
  if (ref && ref.method === 'PATCH' && ref.force) {
    return hold('block', 'force-updating a remote ref (gh api)');
  }
  if (argv[0] === 'git-push') argv = ['git', 'push', ...argv.slice(1)];
  if (argv[0] !== 'git') return null;
  const sub = argv[1];
  const args = argv.slice(2);
  const short = shortFlags(args);
  const pos = positionals(args);
  switch (sub) {
    case 'push':
      return gitPushArgs(args, short, pos);
    case 'reset':
      // --keep refuses to touch uncommitted changes, so it is allowed like --soft and --mixed: the
      // commits it moves the branch off stay in the reflog. --merge can drop changes.
      if (longOpt(args, 'hard')) return hold('block', 'hard reset');
      return longOpt(args, 'merge') ? hold('ask', 'reset --merge') : null;
    case 'clean': {
      const force = longOpt(args, 'force') || /f/.test(short);
      const dry = has(args, '--dry-run') || /n/.test(short);
      return force && !dry ? hold('block', 'forced clean') : null;
    }
    case 'branch': {
      const del = longOpt(args, 'delete') || /d/i.test(short);
      const force = longOpt(args, 'force') || /D|f/.test(short);
      if ((del && force) || /D/.test(short)) return hold('block', 'forced branch delete');
      // git branch -f main HEAD~5 moves an existing branch: its newer commits drop off it.
      return force && pos.length ? hold('ask', `git branch -f ${pos[0]} (moves the branch)`) : null;
    }
    case 'checkout':
      if (longOpt(args, 'force') || /f/.test(short)) return hold('block', 'forced checkout');
      if (!pos.some((a) => ALL.includes(a))) return null;
      return hold('block', 'discarding all local changes');
    case 'switch':
      if (longOpt(args, 'force', 'discard-changes') || /f/.test(short)) {
        return hold('block', 'forced switch');
      }
      return null;
    case 'restore': {
      const staged = has(args, '--staged') || /S/.test(short);
      const stagedOnly = staged && !(has(args, '--worktree') || /W/.test(short));
      if (stagedOnly || !pos.some((a) => ALL.includes(a))) return null;
      return hold('block', 'discarding all local changes');
    }
    case 'stash':
      return ['drop', 'clear'].includes(pos[0]) ? hold('block', `stash ${pos[0]}`) : null;
    case 'update-ref':
      if (!args.includes('-d') && !longOpt(args, 'delete')) return null;
      return hold('block', 'deleting a ref');
    case 'filter-branch':
    case 'filter-repo':
      return hold('block', 'history rewrite');
    case 'reflog':
      return ['expire', 'delete'].includes(pos[0]) ? hold('block', `reflog ${pos[0]}`) : null;
    case 'worktree': {
      const force = longOpt(args, 'force') || /f/.test(short);
      return pos[0] === 'remove' && force ? hold('block', 'forced worktree remove') : null;
    }
    case 'gc':
      if (!args.some((a) => /^--pr(u(ne?)?)?=(now|all)$/.test(a))) return null;
      return hold('block', 'gc --prune=now');
    default:
      return null;
  }
}

export function gitDestructive(ctx) {
  if (ctx.tool !== 'Bash') return null;
  const check = (list) => {
    for (const cmd of list) {
      const r = gitDestructiveArgv(cmd.argv);
      if (r) return r;
      const expanded = expandAlias(cmd.argv, ctx);
      if (expanded) {
        const e = check(expanded);
        if (e) return e;
      }
      const u = unknownGit(cmd, 'resets');
      if (u) return u;
    }
    return null;
  };
  return check(ctx.cmds);
}

// ---------- git configuration that runs programs ----------

// Keys whose value git runs as a program (or that pull in more config) the next time git does
// something ordinary: `git status` with core.fsmonitor set runs it. Matched lowercase.
const EXEC_KEY = new RegExp('^(core\\.(hookspath|fsmonitor|sshcommand|pager|editor|askpass'
  + '|gitproxy)|pager\\..+|sequence\\.editor|diff\\.external|diff\\..+\\.(textconv|command)'
  + '|merge\\..+\\.driver|filter\\..+\\.(clean|smudge|process)|credential(\\..+)?\\.helper'
  + '|alias\\..+|include\\.path|includeif\\..+\\.path|gpg(\\..+)?\\.program'
  + '|(remote\\..+\\.)?(uploadpack|receivepack)(\\..+)?|protocol\\.ext\\.allow'
  + '|interactive\\.difffilter|web\\.browser|browser\\..+\\.(cmd|path)'
  + '|(diff|merge)tool\\..+\\.(cmd|path)|man\\..+\\.(cmd|path)|ssh\\.variant'
  + '|hook\\..+\\.command|hookcmd\\..+\\.(cmd|command)|gpg\\.ssh\\.defaultkeycommand)$');
// Environment variables whose value git (or ssh under git) runs as a program. PAGER only counts
// in front of a git command: `PAGER=less man x` is fine.
const EXEC_ENV = new RegExp('^(GIT_SSH|GIT_SSH_COMMAND|GIT_EDITOR|GIT_SEQUENCE_EDITOR|GIT_PAGER'
  + '|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_ASKPASS|SSH_ASKPASS|GIT_EXEC_PATH|GIT_TEMPLATE_DIR'
  + '|GIT_TRACE2_EVENT_TARGET)=');
const CONFIG_ARG_OPTS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment',
  '--value', '--url']);
const CONFIG_READ = new RegExp('^(--get|--get-all|--get-regexp|--get-urlmatch|-l|--list|--unset'
  + '|--unset-all|--remove-section|--rename-section)$');
const CONFIG_ENV = new RegExp('^(GIT_CONFIG_KEY_\\d+|GIT_CONFIG_PARAMETERS|GIT_CONFIG_GLOBAL'
  + '|GIT_CONFIG_SYSTEM|GIT_CONFIG)=(.*)$', 's');

/** The key a `git config ...` call sets, or null when it only reads or unsets. */
function configSetKey(args) {
  if (has(args, '--edit') || args.includes('-e')) return 'config --edit';
  const pos = [];
  let read = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (CONFIG_ARG_OPTS.has(a)) { i++; continue; }
    if (CONFIG_READ.test(a)) read = true;
    if (a.startsWith('-')) continue;
    pos.push(a);
  }
  if (['get', 'list', 'unset', 'remove-section', 'rename-section'].includes(pos[0])) return null;
  if (pos[0] === 'set') return pos[1] || null;
  if (pos[0] === 'edit') return 'config --edit';
  return !read && pos.length >= 2 ? pos[0] : null;
}

/**
 * Why this command sets git configuration that runs a program, or null: `git config
 * core.hooksPath x`, `git -c core.fsmonitor=... status`, GIT_CONFIG_KEY_0=core.pager,
 * GIT_SSH_COMMAND=x git fetch, export GIT_EXTERNAL_DIFF=x.
 */
export function gitConfigExec(cmd) {
  const keys = [];
  for (const kv of cmd.gitConfig || []) keys.push(kv.split('=')[0]);
  const setsEnv = ['export', 'declare', 'typeset', 'setenv'].includes(cmd.argv[0]);
  const exported = setsEnv ? cmd.argv.slice(1) : [];
  for (const a of [...(cmd.assigns || []), ...exported]) {
    const run = EXEC_ENV.exec(a);
    if (run) return `${run[1]} (git runs it as a program)`;
    if (/^PAGER=/.test(a) && cmd.argv[0] === 'git') return 'PAGER in front of git (git runs it)';
    const m = CONFIG_ENV.exec(a);
    if (!m) continue;
    if (/^GIT_CONFIG_KEY_/.test(m[1])) keys.push(m[2]);
    else if (m[1] === 'GIT_CONFIG_PARAMETERS') {
      for (const k of m[2].matchAll(/'?([\w.:~/-]+)'?\s*=/g)) keys.push(k[1]);
    } else return `${m[1]} (git reads its configuration from another file)`;
  }
  if (cmd.argv[0] === 'git' && cmd.argv[1] === 'config') {
    const k = configSetKey(cmd.argv.slice(2));
    if (k === 'config --edit') return 'git config --edit';
    if (k) keys.push(k);
  }
  const bad = keys.find((k) => EXEC_KEY.test(String(k).trim().toLowerCase()));
  return bad ? `git config ${bad} (git runs it as a program later)` : null;
}
