// flowrail redlines verify: every red line against calls it must hold (positive probes) and calls
// it must allow (negative probes), in a throwaway project folder, through the guard's own
// decide(). init runs it at the end, so "covered" is checked, not claimed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decide, FLOOR, hasHook } from '../guard/rules.js';
import { portRange, commandVariants } from '../guard/builtins.js';
import { paths } from './paths.js';
import { loadLines } from './redlines.js';

const T = (tool, input) => ({ tool, input });
const edit = (file) => T('Edit', { file_path: file, old_string: 'a', new_string: 'b' });

/** Probes per builtin: { hold: [...], allow: [...] }. A string is a Bash command. */
const BUILTIN_PROBES = {
  'git-push': {
    hold: ['git push origin main', 'sudo git -C . push', "bash -c 'git push'"],
    allow: ['git status', 'git commit -m "push the fix"', 'git push --dry-run'],
  },
  'git-destructive': {
    hold: ['git push --force origin main', 'git reset --hard HEAD~1', 'git clean -fd', 'git branch -D old'],
    allow: ['git reset --soft HEAD~1', 'git clean -n', 'git branch -d old'],
  },
  'rm-dangerous': {
    hold: ['rm -rf ~', 'rm -rf /', 'rm -rf ..', 'mv ~ /dev/null'],
    allow: ['rm -rf node_modules', 'rm -rf dist/'],
  },
  'secret-files': {
    hold: ['cat .env', T('Read', { file_path: '.env' }), T('Write', { file_path: '.env', content: 'X=1' }),
      'echo $OPENAI_API_KEY', 'env'],
    allow: ['cat .env.example', 'env | grep NODE_ENV', 'cat README.md'],
  },
  'flowrail-tamper': {
    hold: [T('Write', { file_path: 'flowrail/red-lines.json', content: '[]' }), 'rm flowrail/red-lines.json',
      'tar -xf payload.tar', 'git config core.hooksPath /tmp/h', 'git -c core.fsmonitor=x status'],
    allow: ['cat flowrail/red-lines.json', 'git config user.name x', 'git status'],
  },
  'mcp-actions': {
    hold: [T('mcp__gmail__send_email', { to: 'a@example.com' }), T('mcp__github__merge_pull_request', { number: 1 })],
    allow: [T('mcp__gmail__search_threads', { q: 'x' }), T('mcp__github__get_issue', { number: 1 })],
  },
  'email-send': {
    hold: ['sendmail bob@example.com < mail.txt', T('mcp__gmail__send_email', { to: 'a@example.com' }),
      T('mcp__gmail__reply', { id: '1' })],
    allow: [T('mcp__gmail__create_draft', { to: 'a@example.com' }), 'grep -r sendmail src'],
  },
  payments: {
    hold: [T('mcp__stripe__create_refund', { charge: 'ch_1' }), 'stripe payouts create --amount 100'],
    allow: [T('mcp__stripe__list_charges', {}), 'stripe charges list'],
  },
  'publish-deploy': {
    hold: ['npm publish', 'gh pr merge 42', 'vercel --prod', 'make deploy'],
    allow: ['npm test', 'gh pr view 42'],
  },
  'infra-destructive': {
    hold: ['kubectl delete namespace prod', 'terraform destroy', 'aws s3 rm s3://prod --recursive'],
    allow: ['kubectl get pods', 'terraform plan'],
  },
  'db-destructive': {
    hold: ['psql -c "DROP TABLE users"', 'psql -c "DELETE FROM users"', 'npx prisma migrate reset'],
    allow: ['psql -c "SELECT 1"', 'psql -c "DELETE FROM users WHERE id = 1"'],
  },
};

/** Probes for the recipes that use a regex instead of a builtin. */
const RECIPE_PROBES = {
  'no-drop-table': { hold: ['psql -c "DROP TABLE users"'], allow: ['psql -c "SELECT 1"'] },
  'no-prod-db': { hold: ['psql postgres://prod-db/app'], allow: ['psql postgres://localhost/app'] },
  'protect-migrations': { hold: [edit('db/migrations/001_init.sql')], allow: [edit('src/app.js')] },
  'prefer-pnpm': { hold: ['npm install', 'yarn add left-pad'], allow: ['pnpm install', 'npm test'] },
};

/** A file a protect-path glob covers: content/** -> content/probe.md, docs/*.md -> docs/probe.md. */
export function sampleFile(glob) {
  return String(glob).replace(/^\.\//, '').replace(/\/$/, '/**').replace(/\/\*\*$/, '/probe.md')
    .replace(/\*\*\//g, '').replace(/\*\*/g, 'probe').replace(/\*/g, 'probe').replace(/\?/g, 'x')
    .replace(/\{([^,}]*)[^}]*\}/g, '$1');
}

function protectPathProbes(glob, edits) {
  const f = sampleFile(glob);
  const dir = path.posix.dirname(f);
  const changes = [edit(f), `sed -i 's/a/b/' ${f}`, `echo x >> ${f}`, `perl -pi -e 's/a/b/' ${f}`];
  return {
    hold: [`rm ${f}`, `echo x > ${f}`, T('Write', { file_path: f, content: 'x' }), `mv ${f} /tmp/`,
      ...(dir !== '.' ? [`rm -rf ${dir}`] : []), ...(edits ? changes : [])],
    allow: [...(dir !== '.' ? [`ls ${dir}`] : []), `cat ${f}`, ...(edits ? [] : [edit(f)])],
    files: [f],
  };
}

/**
 * file-field: run the script at a record that has the value (held), at one that does not and at
 * one the exception lets through (allowed), and with no record at all (held: it cannot tell).
 */
function fileFieldProbes(p) {
  const run = p.scripts?.[0] ? `node ${p.scripts[0]}` : p.commands?.[0] ? `${p.commands[0].join(' ')} --` : null;
  if (!run || !p.flag || !p.field || !p.values?.length) return null;
  const rec = (name, fields) => ({ path: `.flowrail-probe/${name}.md`, text: `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n` });
  const files = [rec('held', { [p.field]: p.values[0] }), rec('other', { [p.field]: 'none-of-these' })];
  const [key, vals] = Object.entries(p.except || {})[0] || [];
  if (key && vals?.length) files.push(rec('except', { [p.field]: p.values[0], [key]: vals[0] }));
  return {
    hold: [`${run} ${p.flag} ${files[0].path}`, `${run} ${p.flag}=${files[0].path}`, run],
    allow: files.slice(1).map((f) => `${run} ${p.flag} ${f.path}`),
    files,
  };
}

/** flowrail's probes for one red line, or null when it has none (a regex of your own). */
function ownProbes(line) {
  const b = line.hook && line.hook.builtin;
  const params = line.hook.params || {};
  if (b === 'protect-path') return params.glob ? protectPathProbes(params.glob, !!params.edits) : null;
  if (b === 'command') return Array.isArray(params.argv) && params.argv.length ? commandVariants(params) : null;
  if (b === 'file-field') return fileFieldProbes(params);
  if (b) return BUILTIN_PROBES[b] || null;
  const base = String(line.id).replace(/^protect-path-.*/, 'protect-path');
  return RECIPE_PROBES[base] || null;
}

/**
 * The probes for one red line: flowrail's own, plus the ones stored on the line
 * ("probes": {"hold": [...], "allow": [...]}, written by init from the rule's quoted commands and
 * paths). null when there are none.
 */
export function probesFor(line) {
  const own = ownProbes(line);
  const extra = line.probes && typeof line.probes === 'object' ? line.probes : null;
  if (!extra) return own;
  const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' || (x && typeof x.tool === 'string')) : []);
  const files = list(extra.hold).concat(list(extra.allow)).filter((x) => typeof x !== 'string')
    .map((x) => x.input && x.input.file_path).filter((f) => typeof f === 'string' && !path.isAbsolute(f) && !f.startsWith('..'));
  return {
    hold: [...(own ? own.hold : []), ...list(extra.hold)],
    allow: [...(own ? own.allow : []), ...list(extra.allow)],
    files: [...((own && own.files) || []), ...files],
  };
}

/** Which of these probes one red line holds, in a scratch project: { held: [], missed: [] }. */
export function probeLine(line, probes) {
  const v = verifyRedlines(null, { lines: [{ ...line, probes: { hold: probes, allow: [] } }], noFloor: true });
  const row = v.lines[0];
  const texts = new Map(probes.map((p) => [probeText(p), p]));
  const held = [];
  const missed = [];
  for (const x of row ? row.positive.slice(-probes.length) : []) (x.ok ? held : missed).push(texts.get(x.probe));
  return { held, missed };
}

const asCall = (p) => (typeof p === 'string' ? T('Bash', { command: p }) : p);
export const probeText = (p) => (typeof p === 'string' ? p
  : `${p.tool} ${p.input.file_path || JSON.stringify(p.input)}`);

/**
 * Run every line's probes in a scratch project.
 * @param {string|object} rootOrPaths a workspace root (or its paths), for its red lines
 * @param {{lines?: object[]}} [opts] lines to verify instead of the workspace's
 * @returns {{ok:boolean, lines:object[], held:number, allowedAsExpected:number, failed:number,
 *   probes:number, skipped:{id:string, why:string}[]}}
 */
export function verifyRedlines(rootOrPaths, opts = {}) {
  const p = typeof rootOrPaths === 'string' ? paths(rootOrPaths) : rootOrPaths;
  const own = opts.lines || (p ? loadLines(p) : []);
  const lines = opts.noFloor || own.some((l) => l && l.id === FLOOR.id) ? own : [...own, FLOOR];
  const sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'flowrail-verify-')));
  const out = { ok: true, lines: [], held: 0, allowedAsExpected: 0, failed: 0, probes: 0, skipped: [] };
  try {
    for (const line of lines) {
      if (!line || !hasHook(line)) {
        if (line && line.id) out.skipped.push({ id: line.id, why: 'declared only (no hook to probe)' });
        continue;
      }
      const probes = probesFor(line);
      if (!probes) {
        out.skipped.push({ id: line.id, why: line.hook.builtin ? `${line.hook.builtin} has no built-in probes; add "probes" to the line` : 'a regex of your own: no built-in probes' });
        continue;
      }
      for (const f of probes.files || []) {
        const [rel, text] = typeof f === 'string' ? [f, 'a\n'] : [f.path, f.text];
        fs.mkdirSync(path.join(sandbox, path.dirname(rel)), { recursive: true });
        if (!fs.existsSync(path.join(sandbox, rel))) fs.writeFileSync(path.join(sandbox, rel), text);
      }
      const run = (probe) => {
        const { tool, input } = asCall(probe);
        const floor = line.id === FLOOR.id;
        const ctx = { root: sandbox, roots: [sandbox], cwd: sandbox, ports: portRange(4747), noFloor: !floor };
        return decide(floor ? [] : [line], tool, input, floor ? { ...ctx, noFloor: false } : ctx).decision;
      };
      const positive = probes.hold.map((probe) => {
        const decision = run(probe);
        return { probe: probeText(probe), decision, ok: decision !== 'allow' };
      });
      const negative = probes.allow.map((probe) => {
        const decision = run(probe);
        return { probe: probeText(probe), decision, ok: decision === 'allow' };
      });
      const row = { id: line.id, severity: line.severity, ...(line.floor || line.id === FLOOR.id ? { floor: true } : {}), positive, negative };
      out.lines.push(row);
      out.held += positive.filter((x) => x.ok).length;
      out.allowedAsExpected += negative.filter((x) => x.ok).length;
      out.failed += positive.filter((x) => !x.ok).length;
      out.probes += positive.length + negative.length;
    }
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
  out.ok = out.failed === 0;
  return out;
}

export const verify = verifyRedlines;
