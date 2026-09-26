// Red-line recipes: ready-made rules for common hard rules people already write in CLAUDE.md.
// `detect` finds the rule in prose: it matches the rule's intent (what may not happen, to what),
// never a loose keyword, because a recipe that matches is reported as "covered".
// Hook regexes run against normalized simple commands (see shell.js), e.g. "git push origin main".
// Every recipe also ships as examples/red-lines/<id>.json.
import { parseQuoted } from '../guard/builtins.js';

// "Never", "don't", "ask before", "without asking": the rule forbids or gates something.
const NEG = String.raw`(?:never|don'?t|do not|dont|must not|mustn'?t|no|not|avoid|ask (?:me |first `
  + String.raw`|the human )?before|without|only after|only with|forbidden|not allowed to)`;
const gate = (object) => new RegExp(String.raw`\b${NEG}\b[^.;]*?\b(?:${object})`, 'i');

export const RECIPES = [
  {
    id: 'no-push-without-asking',
    title: 'Never push without asking',
    why: 'Pushing publishes work. A human decides when.',
    severity: 'ask',
    hook: { tool: 'Bash|mcp__*', builtin: 'git-push' },
    detect: gate(String.raw`push(es|ing)?\b`),
    starter: true,
  },
  {
    id: 'no-destructive-git',
    title: 'No destructive git commands',
    why: 'Force pushes, hard resets, forced cleans and branch deletes lose work that may not exist '
      + 'anywhere else.',
    severity: 'block',
    hook: { tool: 'Bash', builtin: 'git-destructive' },
    detect: /force[- ]push|--force|reset --hard|destructive git|branch -D|rewrite (git )?history/i,
    starter: true,
  },
  {
    id: 'no-secrets-in-repo',
    title: 'Keep secrets out of the repo and out of the chat',
    why: 'Committed secrets leak through history even after they are deleted, and a secret read '
      + 'into the session is a secret shared.',
    severity: 'block',
    hook: { tool: '*', builtin: 'secret-files' },
    check: {
      glob: '**/*', pattern: '-----BEGIN [A-Z ]*PRIVATE KEY-----', message: 'Private key committed to the repo',
    },
    detect: new RegExp(String.raw`\.env\b|\b${NEG}\b[^.;]*\b(secrets?|credentials?|api[- ]?keys?`
      + String.raw`|private keys?|tokens?)\b|\b(secrets?|credentials?|api[- ]?keys?|private keys?)\b`
      + String.raw`[^.;]*\b(out of|never|not)\b`, 'i'),
    gaps: 'a secret pasted into an ordinary file is only found by the private-key check (flowrail check)',
    starter: true,
  },
  {
    id: 'no-rm-rf-outside-project',
    title: 'No recursive deletes outside the project',
    why: 'One typo away from an empty disk.',
    severity: 'block',
    hook: { tool: 'Bash', builtin: 'rm-dangerous' },
    detect: /rm -r?f|rm -r\b|delete (the )?(root|home|everything)|outside (the |this )?(repo|project)/i,
    starter: true,
  },
  {
    id: 'protect-flowrail',
    title: 'Ask before changing the guardrails',
    why: 'Red lines, flowrail settings and the Claude Code hooks are the human\'s to change. An agent '
      + 'that edits them has switched off its own seatbelt.',
    severity: 'ask',
    hook: { tool: '*', builtin: 'flowrail-tamper' },
    detect: gate(String.raw`red[- ]lines?|guardrails?|\.claude/settings|claude (code )?settings|flowrail`),
    starter: true,
  },
  {
    id: 'ask-before-mcp-actions',
    title: 'Ask before MCP tools send, publish, merge or delete',
    why: 'An MCP tool that sends an email, merges a pull request or deletes a record acts in the '
      + 'world. A human says yes first.',
    severity: 'ask',
    hook: { tool: 'mcp__*', builtin: 'mcp-actions' },
    detect: gate(String.raw`mcp\b|slack\b|(post|send)\w* (a |any )?(message|dm)s?\b|calendar\b`
      + String.raw`|(meeting )?invites?\b|meetings?\b|notion\b|shared (docs?|documents?)\b`),
    starter: true,
  },
  {
    id: 'no-deploy-without-asking',
    title: 'Ask before deploying',
    blockTitle: 'Never deploy',
    why: 'Deploys change what users see. A human presses the button.',
    severity: 'ask',
    hook: { tool: 'Bash', builtin: 'publish-deploy' },
    detect: gate('deploy'),
    gaps: 'deploys from CI or from a script of your own are not held',
  },
  {
    id: 'no-publish-without-asking',
    title: 'Ask before publishing a package or release',
    blockTitle: 'Never publish a package or release',
    why: 'A published version cannot be taken back.',
    severity: 'ask',
    hook: { tool: 'Bash', builtin: 'publish-deploy' },
    detect: gate(String.raw`publish|release\b|merge\b`),
    gaps: 'publishing from CI or from a script of your own is not held',
  },
  {
    id: 'no-emails-without-signoff',
    title: 'Never send email without sign-off',
    why: 'Email cannot be unsent. Drafts are fine; sending needs a human.',
    severity: 'block',
    hook: { tool: '*', builtin: 'email-send' },
    detect: gate(String.raw`e-?mails?\b|newsletters?\b`),
    gaps: 'email sent from a script of your own is not held',
  },
  {
    id: 'no-payments',
    title: 'Never move money without a human',
    why: 'Charges, refunds and payouts reach real people\'s accounts.',
    severity: 'block',
    hook: { tool: '*', builtin: 'payments' },
    detect: gate(String.raw`payments?\b|charges?\b|refunds?\b|payouts?\b|stripe\b|paypal\b|money\b`),
  },
  {
    id: 'infra-destructive',
    title: 'Ask before destroying infrastructure',
    blockTitle: 'Never destroy infrastructure',
    why: 'Deleted clusters, stacks and buckets take production with them.',
    severity: 'ask',
    hook: { tool: 'Bash', builtin: 'infra-destructive' },
    detect: gate(String.raw`kubectl (delete|drain)|terraform destroy|infra(structure)?\b|clusters?\b`
      + String.raw`|pulumi destroy|aws s3 rm`),
  },
  {
    id: 'no-drop-table',
    title: 'Never drop tables or databases',
    why: 'Dropped data is gone unless a backup is fresh and tested.',
    severity: 'block',
    hook: { tool: 'Bash', match: '\\bdrop\\s+(table|database|schema)\\b', flags: 'i', raw: true },
    detect: /drop (table|database|schema)/i,
  },
  {
    id: 'db-destructive',
    title: 'Ask before destroying data',
    blockTitle: 'Never destroy data',
    why: 'DROP, TRUNCATE and a DELETE without WHERE remove rows no one gets back without a backup.',
    severity: 'ask',
    hook: { tool: 'Bash', builtin: 'db-destructive' },
    detect: gate(String.raw`truncate|(delete|wipe|reset|drop)\w* (the |any |all )?(data|rows|records`
      + String.raw`|database|db)\b|migrate reset|db:drop`),
  },
  {
    id: 'publish-deploy',
    title: 'Ask before publishing, merging or deploying',
    blockTitle: 'Never publish, merge or deploy',
    why: 'Releases, merged pull requests and deploys reach users. A human presses the button.',
    severity: 'ask',
    hook: { tool: 'Bash', builtin: 'publish-deploy' },
    detect: null, // offered by init when the project deploys or publishes (see tooling())
    gaps: 'deploys from CI or from a script of your own are not held',
  },
  {
    id: 'no-prod-db',
    title: 'Ask before touching the production database',
    blockTitle: 'Never touch the production database',
    why: 'Production data belongs to users.',
    severity: 'ask',
    hook: {
      tool: 'Bash', match: '^(psql|mysql|mongosh|mongo|redis-cli|pg_dump|pg_restore)\\b.*(prod|production)', flags: 'i',
    },
    detect: /\bprod(uction)?\b[^.]*\b(db|database)\b|\b(db|database)\b[^.]*\bprod(uction)?\b/i,
  },
  {
    id: 'protect-migrations',
    title: 'Ask before editing existing migrations',
    blockTitle: 'Never edit existing migrations',
    why: 'Migrations that already ran elsewhere must not change. Write a new one.',
    severity: 'ask',
    hook: { tool: 'Write|Edit|MultiEdit', match: '(^|/)(migrations?|db/migrate)/' },
    // Only rules about changing old migrations; "never run migrations against prod" is not this.
    detect: new RegExp(String.raw`\b(edit|chang|modif|rewrit|alter|touch)\w*\b[^.]*\bmigrations?\b`
      + String.raw`|\bmigrations?\b[^.]*\b(edit|chang|modif|rewrit)\w*`, 'i'),
  },
  {
    id: 'protect-path',
    title: 'Ask before deleting, moving or overwriting files in content/',
    blockTitle: 'Never delete, move or overwrite files in content/',
    why: 'These files are the product. Deleting or replacing them is a human decision.',
    severity: 'ask',
    hook: { tool: '*', builtin: 'protect-path', params: { glob: 'content/**' } },
    detect: null, // found by pathRule(), which fills in the folder the rule names
  },
  {
    id: 'prefer-pnpm',
    title: 'Use pnpm, not npm or yarn',
    why: 'This project uses pnpm. npm or yarn would write a second lockfile.',
    severity: 'ask',
    hook: { tool: 'Bash', match: '^(npm (install|i|ci|add|update|uninstall|remove)\\b|yarn(\\s|$))' },
    // "Use pnpm, not npm" and "never use npm install" are this; "run pnpm test" is not.
    detect: new RegExp(String.raw`\b(use|prefer|only)\s+pnpm\b|\bpnpm\b[^.;]*\b(not|instead of`
      + String.raw`|rather than|over|never)\b[^.;]*\b(npm|yarn)\b|\b(never|don'?t|do not|no)\s+`
      + String.raw`(use\s+|run\s+)?(npm|yarn)\b(?!\s+(test|run)\b)`, 'i'),
  },
];

/** A folder named in a rule, without trailing punctuation: "content/." -> "content". */
const cleanDir = (d) => d.replace(/^\.\//, '').replace(/[/.,;:!?)]+$/, '');

const PATH_RULE = new RegExp(String.raw`\b(delete|remove|rm|move|rename|overwrite|replace|wipe)\b`
  + String.raw`[^.]*?\b(?:in|under|from|inside|within)\s+(?:the\s+)?[\x60'"]?([\w.-]+(?:\/[\w.-]+)*)`
  + String.raw`(\/\*\*(?:\/\*[\w.*-]*)?|\/\*[\w.*-]*)?\/?[\x60'"]?(?:\s+(?:folder|directory|dir))?`
  + String.raw`(?=[\s.,;:)!?]|$)`, 'i');

/** "Don't delete anything in content/" -> a protect-path recipe for content/**. null otherwise. */
export function pathRule(rule) {
  const m = PATH_RULE.exec(rule);
  if (!m) return null;
  const dir = cleanDir(m[2]);
  if (!dir || /^(the|a|this|that|any|repo|project|production|prod)$/i.test(dir)) return null;
  const base = RECIPES.find((r) => r.id === 'protect-path');
  const slug = dir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  // The glob as the rule wrote it (src/generated/**), or the folder and everything in it.
  const glob = m[3] ? `${dir}${m[3]}` : `${dir}/**`;
  return {
    ...base,
    id: `protect-path-${slug}`,
    title: `Ask before deleting, moving or overwriting files in ${m[3] ? glob : `${dir}/`}`,
    blockTitle: `Never delete, move or overwrite files in ${m[3] ? glob : `${dir}/`}`,
    hook: { ...base.hook, params: { glob } },
  };
}

// ---------- the rule's own words: quoted commands, named paths, severity ----------

const EDIT_WORDS = /\b(touch|edit|modif|chang|writ|overwrit|replac|rewrit|updat)\w*/i;
const DELETE_WORDS = /\b(delet|remov|rm\b|mov|renam|wip|clean)\w*/i;
const isPath = (w) => !/\s/.test(w) && !/^[a-z]+:\/\//i.test(w)
  && (w.includes('/') || /^\.?[\w-]*\.[a-z0-9]{1,6}$/i.test(w)) && !/^[\d./]+$/.test(w);
const isCommand = (w) => /\s/.test(w) && /^[\w./-]+\s/.test(w) && !/^(the|a|an|to|and|or|not)\s/i.test(w);

/**
 * What a rule names literally: quoted commands ("`npm run db:migrate:prod`") and paths (quoted,
 * or unquoted folders like infra/terraform/ and files like config/prod.yml). These are the
 * rule's own probes: "covered" means every one of them is held.
 * @returns {{commands: string[], paths: string[]}}
 */
export function literals(rule) {
  const commands = [];
  const paths = [];
  const text = String(rule);
  // "Always run `pnpm test`", "Only use `src/`": a positive rule names what to do, not what to hold.
  if (isPositive(text)) return { commands, paths };
  for (const m of text.matchAll(/`([^`]+)`|"([^"]+)"|'([^'\s][^']*)'/g)) {
    const q = (m[1] ?? m[2] ?? m[3]).trim();
    if (isPath(q)) paths.push(cleanDir(q));
    else if (isCommand(q)) commands.push(q);
  }
  const bare = text.replace(/`[^`]*`|"[^"]*"/g, ' ');
  for (const m of bare.matchAll(/(?:^|[\s(])(\.{0,2}\/?[\w.-]+(?:\/[\w.*-]+)*\/)(?=[\s.,;:)!?]|$)/g)) {
    if (m[1].includes('/') && !/^\/+$/.test(m[1])) paths.push(cleanDir(m[1]));
  }
  for (const m of bare.matchAll(/(?:^|[\s(])((?:[\w.-]+\/)+[\w-]+\.[a-z0-9]{1,6})(?=[\s.,;:)!?]|$)/gi)) paths.push(m[1]);
  return { commands: [...new Set(commands)], paths: [...new Set(paths.filter(Boolean))] };
}

/**
 * The severity a rule's wording asks for: "without my OK", "on your own", "ask me first" -> ask;
 * "never" or "do not" without such a qualifier -> block; null when it says neither.
 */
export function wordingSeverity(rule) {
  const qualified = new RegExp(String.raw`without (my |our |the human'?s? |explicit |a human'?s? )?`
    + String.raw`(ok|okay|approval|permission|sign-?off|consent|asking|confirmation|review)`
    + String.raw`|on (your|its|their) own|ask (me|us|first|the human|before)|check with (me|us)`
    + String.raw`|unless (i|we) (say|approve|confirm|ask)|only (after|with) (my|our|explicit)`, 'i');
  if (qualified.test(rule)) return 'ask';
  if (/\b(never|do not|don'?t|must not|mustn'?t|not allowed|forbidden|no)\b/i.test(rule)) return 'block';
  return null;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A rule that says what to do (always, only, prefer) and forbids nothing: no literal holds. */
export const isPositive = (rule) => wordingSeverity(rule) === null;

/** The severity a recipe gets for this rule: the starters keep theirs, the rest follow the words. */
export const recipeSeverity = (recipe, rule) => (recipe.starter ? recipe.severity
  : wordingSeverity(rule) || recipe.severity);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** The probes a rule's literals give: a quoted command, and for a path what the rule forbids. */
export function literalProbes(rule) {
  const { commands, paths } = literals(rule);
  const hold = [...commands];
  const edits = EDIT_WORDS.test(rule);
  const deletes = DELETE_WORDS.test(rule) || /\btouch/i.test(rule) || !edits;
  for (const p of paths) {
    const dir = !/\.[a-z0-9]{1,6}$/i.test(p);
    const file = dir ? `${p}/probe.txt` : p;
    if (deletes) hold.push(dir ? `rm -rf ${p}` : `rm ${p}`);
    if (edits) hold.push({ tool: 'Edit', input: { file_path: file, old_string: 'a', new_string: 'b' } });
  }
  return hold;
}

/**
 * Red lines that hold exactly what a rule names, for the literals no recipe holds: a quoted command
 * becomes a `command` line (argv matching: flags in any order, long or short); a named folder or
 * file becomes a protect-path line, with `edits` when the rule says touch, edit, modify or change.
 */
export function literalLines(rule, missed, { source = 'CLAUDE.md', severity } = {}) {
  const sev = severity || wordingSeverity(rule) || 'ask';
  const never = sev === 'block';
  const why = `Written in ${source}: "${quoteOf(rule)}".`;
  const out = [];
  const { commands, paths } = literals(rule);
  const miss = (p) => missed.some((m) => (typeof m === 'string' ? m : m.input.file_path).includes(p));
  for (const cmd of commands.filter(miss)) {
    const params = parseQuoted(cmd);
    const words = cmd.split(/\s+/);
    out.push({
      id: `cmd-${slug(cmd)}`, title: `${never ? 'Never run' : 'Ask before running'} ${cmd}`, why, severity: sev,
      hook: params ? { tool: 'Bash', builtin: 'command', params }
        : { tool: 'Bash', match: `^${words.map(escapeRe).join('\\s+')}(\\s|$)` },
      probes: { hold: [cmd], allow: [] },
    });
  }
  const edits = EDIT_WORDS.test(rule);
  for (const p of paths.filter(miss)) {
    const dir = !/\.[a-z0-9]{1,6}$/i.test(p) && !/\*/.test(p);
    const shown = dir ? `${p}/` : p;
    const glob = dir ? `${p}/**` : p;
    const probes = literalProbes(rule).filter((x) => (typeof x === 'string' ? x : x.input.file_path).includes(p));
    const verbs = edits ? ['change', 'changing'] : ['delete', 'deleting'];
    out.push({
      id: `protect-path-${slug(p)}`,
      title: never ? `Never ${verbs[0]}, move or overwrite ${shown}` : `Ask before ${verbs[1]}, moving or overwriting ${shown}`,
      why, severity: sev, hook: { tool: '*', builtin: 'protect-path', params: { glob, ...(edits ? { edits: true } : {}) } },
      probes: { hold: probes, allow: [] },
    });
  }
  return out;
}

/** A recipe as a red-line entry (without the detection regex). */
export function asRedLine(recipe, severity = recipe.severity) {
  const { detect, starter, gaps, blockTitle, ...line } = recipe;
  const title = severity === 'block' && blockTitle ? blockTitle : line.title;
  return JSON.parse(JSON.stringify({ ...line, title, severity }));
}

export const starterLines = () => RECIPES.filter((r) => r.starter).map((r) => asRedLine(r));

const RULE_RE = new RegExp(String.raw`\b(never|do not|don't|dont|must not|mustn't|no|always|only`
  + String.raw`|ask before|only after|without (asking|approval|sign-?off)|prefer)\b`
  + String.raw`|\buse\s+[\w.-]+\s*,?\s+(not|instead of|rather than)\b`, 'i');

const quoteOf = (rule) => {
  const clean = rule.replace(/[.;:,]+$/, '');
  return clean.length > 90 ? clean.slice(0, 87) + '...' : clean;
};

/** The recipe that enforces a rule written in prose, or null. */
export function recipeFor(rule) {
  const byPath = pathRule(rule);
  if (byPath) return byPath;
  for (const recipe of RECIPES) {
    if (!recipe.detect || !recipe.detect.test(rule)) continue;
    // "never force push" is the destructive-git recipe, not the plain push one.
    if (recipe.id === 'no-push-without-asking' && /force|--force/i.test(rule)) continue;
    return recipe;
  }
  return null;
}

/**
 * Find imperative rules in CLAUDE.md/AGENTS.md text and the recipes that would enforce them.
 * `matches` has one entry per rule (recipe null when no recipe fits); `proposals` one per recipe.
 * `skipped` lists the bullet points that are not rules (reported, never silently dropped).
 * @returns {{ rules: string[], matches: {rule:string, quote:string, recipe:object|null}[],
 *   proposals: {recipe: object, quote: string}[], skipped: string[] }}
 */
export function scanRules(text) {
  const rules = [];
  const skipped = []; // list items that are not a prohibition or an "always" rule
  let inCode = false;
  let inBlock = false;
  for (const raw of String(text).split('\n')) {
    if (raw.includes('<!-- flowrail:start -->')) { inBlock = true; continue; }
    if (raw.includes('<!-- flowrail:end -->')) { inBlock = false; continue; }
    if (raw.trim().startsWith('```')) { inCode = !inCode; continue; }
    if (inCode || inBlock) continue;
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw);
    const line = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, '$1').trim(); // bold, not globs
    if (line.length < 6 || line.startsWith('#') || line.startsWith('<!--')) continue;
    if (RULE_RE.test(line)) rules.push(line);
    else if (bullet) skipped.push(quoteOf(line));
  }
  const matches = rules.map((rule) => ({ rule, quote: quoteOf(rule), recipe: recipeFor(rule) }));
  const proposals = [];
  const seen = new Set();
  for (const m of matches) {
    if (!m.recipe || seen.has(m.recipe.id)) continue;
    seen.add(m.recipe.id);
    proposals.push({ recipe: m.recipe, quote: m.quote, rule: m.rule });
  }
  return { rules, matches, proposals, skipped };
}

// ---------- Claude Code permissions ----------

/**
 * permissions.deny and permissions.ask from .claude/settings.json and settings.local.json, as
 * [{ kind: 'deny'|'ask', rule: 'Bash(terraform apply:*)', file }]. Claude Code enforces these
 * itself, so a CLAUDE.md rule one of them states is covered even without a red line.
 */
export function permissionRules(settingsList) {
  const out = [];
  for (const { file, settings } of settingsList) {
    const perms = settings && typeof settings.permissions === 'object' ? settings.permissions : {};
    for (const kind of ['deny', 'ask']) {
      for (const rule of Array.isArray(perms[kind]) ? perms[kind] : []) {
        if (typeof rule === 'string') out.push({ kind, rule, file });
      }
    }
  }
  return out;
}

/** The permission rule that says what a CLAUDE.md rule says, or null. */
export function permissionFor(rule, perms) {
  const text = ` ${String(rule).toLowerCase().replace(/[`'"]/g, '')} `;
  for (const p of perms) {
    const m = /^(\w+)\((.*)\)$/.exec(p.rule.trim());
    if (!m) continue;
    // Bash(terraform apply:*) -> "terraform apply"; Read(./.env) -> ".env"; Edit(content/**) -> "content"
    const body = m[2].replace(/:\*$/, '').replace(/\*+$/, '').replace(/^\.\//, '').replace(/\/+$/, '')
      .trim().toLowerCase();
    if (body.length < 3) continue;
    if (text.includes(m[1] === 'Bash' ? ` ${body}` : body)) return p;
  }
  return null;
}
