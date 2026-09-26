// Loader and runner for the public probe corpus in test/corpus/<builtin>.txt.
import fs from 'node:fs';
import path from 'node:path';
import { decide } from '../src/core/redlines.js';
import { portRange } from '../src/guard/builtins.js';

export const DIR = path.join(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), 'corpus');
export const ROOT = '/work/project';
const FILE_TOOL = /^(Write|Edit|MultiEdit|NotebookEdit|Read|Grep): (.+)$/;
const JSON_TOOL = /^(mcp__[\w-]+__[\w-]+|[A-Z]\w*) (\{.*\})$/; // any tool with its input as JSON: mcp__github__push_files {"repo":"x"}

/** { builtin: [{ expect: 'HOLD'|'ALLOW'|'GAP', call, line }] }. GAP: a known miss, documented, not held. */
export function load() {
  const out = {};
  for (const file of fs.readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort()) {
    const probes = [];
    let params;
    let env;
    fs.readFileSync(path.join(DIR, file), 'utf8').split('\n').forEach((raw, i) => {
      if (raw.startsWith('|') && probes.length) { probes[probes.length - 1].call += '\n' + raw.slice(1); return; }
      // "#! params {...}": the builtin's params for the lines below (protect-path edits, command argv).
      const pm = /^#! params (\{.*\})$/.exec(raw);
      if (pm) { params = JSON.parse(pm[1]); return; }
      // "#! env {...}": environment for the lines below (CLAUDE_CONFIG_DIR).
      const em = /^#! env (\{.*\})$/.exec(raw);
      if (em) { env = JSON.parse(em[1]); return; }
      const m = /^(HOLD|ALLOW|GAP) (.+)$/.exec(raw);
      if (m) probes.push({ expect: m[1], call: m[2], line: i + 1, ...(params ? { params } : {}), ...(env ? { env } : {}) });
    });
    out[file.replace(/\.txt$/, '')] = probes;
  }
  return out;
}

/** What one builtin decides for one probe, at severity block. */
export function run(builtin, call, given, env) {
  if (env) {
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try { return run(builtin, call, given); } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
  const params = given || (builtin === 'protect-path' ? { glob: 'content/**' } : undefined);
  const line = { id: 'probe', title: 'probe', severity: 'block', hook: { tool: '*', builtin, ...(params ? { params } : {}) } };
  const j = JSON_TOOL.exec(call);
  if (j) return decide([line], j[1], JSON.parse(j[2]), { root: ROOT, cwd: ROOT, ports: portRange(4747), noFloor: true });
  const f = FILE_TOOL.exec(call);
  const tool = f ? f[1] : 'Bash';
  const input = !f ? { command: call } : tool === 'Grep' ? { pattern: 'x', path: f[2] } : tool === 'NotebookEdit' ? { notebook_path: f[2] } : { file_path: f[2] };
  return decide([line], tool, input, { root: ROOT, cwd: ROOT, ports: portRange(4747), noFloor: true });
}
