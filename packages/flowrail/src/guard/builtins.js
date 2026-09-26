// Built-in red-line matchers: argv and flag parsing instead of one ordered regex.
// A red line selects one with  "hook": { "tool": "*", "builtin": "git-destructive" }.
//
// Each matcher looks at one tool call and returns null (no opinion) or { severity, what }:
// severity is the most the matcher asks for ('block' or 'ask'); the red line's own severity caps
// it, so a line with severity "ask" never blocks. `what` names the thing that was held.
//
// Bash commands arrive parsed by shell.js (wrappers, quotes, backslashes and `sh -c` undone).
// The matchers live in builtins/, one file per family. The public probe corpus for every matcher
// is test/corpus/<builtin>.txt. Part of the vendored guard: node: builtins and ./ files only.
import path from 'node:path';
import { commands } from './shell.js';
import { toPosix, realish } from './builtins/common.js';
import { gitPush, gitDestructive } from './builtins/git.js';
import { rmDangerous } from './builtins/rm.js';
import { secretFiles } from './builtins/secrets.js';
import { flowrailTamper } from './builtins/tamper.js';
import { mcpActions, emailSend, payments } from './builtins/actions.js';
import { publishDeploy, infraDestructive, dbDestructive } from './builtins/deploy.js';
import { protectPath } from './builtins/protect-path.js';
import { quotedCommand } from './builtins/command.js';

export { toPosix, resolveWord, realish, mcpName, globToRegex } from './builtins/common.js';
export { isSecretName, findSecret, SECRET_PATTERNS } from './builtins/secrets.js';
export { PROTECTED, BLOCK_START, BLOCK_END, flowrailArgs } from './builtins/tamper.js';
export { gitConfigExec } from './builtins/git.js';
export { parseQuoted, commandVariants } from './builtins/command.js';

const VERB = { block: 'Blocks', ask: 'Asks before', warn: 'Warns on' };

export const BUILTINS = {
  'git-push': {
    check: gitPush,
    summary: (s) => `${VERB[s]} any git push (also git send-pack, git subtree push, hub push, `
      + 'gh repo sync, and git aliases that push)',
  },
  'git-destructive': {
    check: gitDestructive,
    summary: (s) => `${VERB[s]} force pushes, hard resets, forced cleans, forced branch deletes, `
      + 'discarding all local changes, dropping stashes and history rewrites'
      + (s === 'block' ? '; asks before deleting a remote branch or reset --merge' : ''),
  },
  'rm-dangerous': {
    check: rmDangerous,
    summary: (s) => `${VERB[s]} recursive deletes of /, your home folder, everything (*, .) or `
      + 'anything outside this project (following symlinks), moving your home folder away, and '
      + 'wiping disks (dd onto a disk, mkfs, diskutil erase)'
      + (s === 'block' ? '; asks when the path is a variable' : ''),
  },
  'secret-files': {
    check: secretFiles,
    summary: (s) => (s === 'block'
      ? 'Blocks writing .env files, keys and other secret files, and writing API keys or private '
        + 'keys into any file; asks before reading secret files, printing the whole environment, '
        + 'echoing $API_KEY-style variables or printing a credential (gh auth token, op read)'
      : `${VERB[s]} reading or writing .env files, keys and other secret files, writing API keys `
        + 'into files, and printing secrets into the session'),
  },
  'flowrail-tamper': {
    check: flowrailTamper,
    summary: (s) => `${VERB[s]} changing red lines, flowrail config, the guard, Claude settings `
      + 'and hooks, .git/config, .git/hooks, .mcp.json or the flowrail block in CLAUDE.md '
      + '(by name, or by extracting an archive or applying a patch over them), git config that '
      + 'runs programs (core.hooksPath, core.fsmonitor, aliases), reading the machine-local key '
      + 'and journal, uninstalling the hooks, and calling the dashboard API',
  },
  'mcp-actions': {
    check: mcpActions,
    summary: (s) => `${VERB[s]} MCP tools that send, post, publish, push, merge, delete, deploy, `
      + 'pay or share, on any MCP server',
  },
  'email-send': {
    check: emailSend,
    summary: (s) => `${VERB[s]} sending email: sendmail, mutt, swaks, mail APIs (SendGrid, `
      + 'Postmark, Resend, Mailgun, SES) and send, forward and reply tools on mail MCP servers; '
      + 'drafts are fine',
  },
  payments: {
    check: payments,
    summary: (s) => `${VERB[s]} moving money: charges, refunds, payouts and transfers on payment `
      + 'MCP servers (Stripe, PayPal and others), the Stripe CLI and the Stripe API',
  },
  'publish-deploy': {
    check: publishDeploy,
    summary: (s) => `${VERB[s]} publishing packages and releases, merging pull requests and `
      + 'deploying (npm publish, gh pr merge, gh release create, vercel --prod, fly deploy, '
      + 'make deploy, terraform apply and more)',
  },
  'infra-destructive': {
    check: infraDestructive,
    summary: (s) => `${VERB[s]} destroying infrastructure: kubectl delete, terraform destroy and `
      + 'apply -auto-approve, aws ... delete-*/terminate-*, aws s3 rm --recursive, gcloud and az '
      + '... delete, helm uninstall, pulumi destroy, docker volume rm',
  },
  'db-destructive': {
    check: dbDestructive,
    summary: (s) => `${VERB[s]} destroying data: DROP, TRUNCATE and DELETE without WHERE sent to `
      + 'psql, mysql, sqlite3 or mongosh, prisma migrate reset, rails db:drop, dropdb, '
      + 'redis-cli flushall',
  },
  command: {
    check: quotedCommand,
    params: (p) => {
      const strings = (v) => Array.isArray(v) && v.every((w) => typeof w === 'string');
      return strings(p.argv) && p.argv.length && (p.flags === undefined || strings(p.flags)) ? null
        : 'command needs "params": { "argv": ["git", "commit"], "flags": ["--no-verify"] }';
    },
    summary: (s, p = {}) => `${VERB[s]} ${[...(p.argv || []), ...(p.flags || [])].join(' ')}`
      + ((p.flags || []).length ? ' (its flags in any order, long or short, bundled or not)' : ''),
  },
  'protect-path': {
    check: protectPath,
    params: (p) => (typeof p.glob === 'string' && p.glob.trim()
      ? null : 'protect-path needs "params": { "glob": "content/**" }'),
    summary: (s, p = {}) => (p.edits
      ? `${VERB[s]} changing, moving or deleting ${p.glob || '(no glob set)'} (Write, Edit, rm, `
        + 'mv, cp over, > and >>, tee, sed -i, perl -pi, truncate, MCP write tools)'
      : `${VERB[s]} deleting, moving or overwriting files under `
        + `${p.glob || '(no glob set)'} (rm, mv, git rm, find -delete, > redirects, Write over an `
        + 'existing file); editing part of a file is fine'),
  },
};

export const BUILTIN_IDS = Object.keys(BUILTINS);

/** The ports a flowrail dashboard may bind: the configured one and the next ten. */
export const portRange = (port) => Array.from({ length: 11 }, (_, i) => Number(port) + i);

/**
 * Run one builtin against a tool call.
 * @param {string} id builtin id
 * @param {{tool:string, input:object, root:string, roots?:string[], cwd?:string, ports?:number[],
 *   cmds?:object[], params?:object}} ctx
 */
export function runBuiltin(id, ctx) {
  const b = BUILTINS[id];
  if (!b) return null;
  // Symlinks resolved (macOS /var/folders is /private/var/folders): the hook, `redlines test` and
  // `redlines verify` see the same project whichever spelling of its path they were given.
  const real = (p) => realish(toPosix(path.resolve(p)));
  const root = real(ctx.root || ctx.cwd || process.cwd());
  const input = ctx.input || {};
  return b.check({
    ...ctx,
    root,
    roots: (ctx.roots && ctx.roots.length ? ctx.roots : [root]).map(real),
    cwd: real(ctx.cwd || ctx.root || process.cwd()),
    ports: ctx.ports || portRange(4747),
    input,
    cmds: ctx.cmds || (ctx.tool === 'Bash' ? commands(String(input.command ?? '')) : []),
  });
}
