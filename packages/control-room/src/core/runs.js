// Headless runs: `claude -p` (read-only tools) or a plain command. One at a time.
// Recorded in .flowrail/runs/<id>.json + <id>.log. Red lines still apply through the hooks.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readJson, writeJson, listFiles, nowIso, stamp, randomId } from 'flowrail/api';

const READ_ONLY = ['status', 'tasks', 'comments', 'recall', 'redlines', 'doctor', 'check', 'today'];

export const HEADLESS = {
  permissionMode: 'dontAsk',
  // Read-only flowrail subcommands only: never uninstall, hooks, routines, init or upgrade.
  allowed: ['Read', 'Grep', 'Glob', 'LS', 'Bash(git status:*)', 'Bash(git log:*)', 'Bash(git diff:*)', 'Bash(git show:*)',
    ...READ_ONLY.flatMap((sub) => ['npx flowrail', 'flowrail', 'npx @flowrail/control-room', 'flowrail-room'].map((cli) => `Bash(${cli} ${sub}:*)`)), 'Write(./flowrail/artifacts/**)'],
  disallowed: ['WebFetch', 'WebSearch', 'Bash(git push:*)', 'Bash(git commit:*)', 'Bash(rm:*)', 'Bash(curl:*)', 'Bash(wget:*)', 'Bash(ssh:*)', 'Bash(scp:*)', 'Edit', 'NotebookEdit'],
};
const CAP = 200 * 1024;
const TIMEOUT = 30 * 60000;

let claudeCache;
export function hasClaude() {
  if (claudeCache === undefined) {
    try {
      const r = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      claudeCache = r.status === 0 ? (r.stdout.trim() || 'claude') : null;
    } catch { claudeCache = null; }
  }
  return claudeCache;
}

const lockFile = (p) => path.join(p.runs, '.lock');

function locked(p) {
  const l = readJson(lockFile(p), null);
  if (!l) return null;
  try { process.kill(l.pid, 0); return l; } catch { fs.rmSync(lockFile(p), { force: true }); return null; }
}

export function busy(p) {
  return locked(p);
}

/**
 * Start a run. Resolves `done` with the final record.
 * @param {{kind:'claude', prompt:string} | {kind:'command', cmd:string[]}} spec
 * @param {{routine?:string, title?:string}} [meta]
 */
export function start(p, spec, meta = {}) {
  const holder = locked(p);
  if (holder) throw Object.assign(new Error(`another run is in progress (${holder.id}); flowrail runs one at a time`), { status: 409 });
  let file;
  let args;
  if (spec.kind === 'claude') {
    if (!spec.prompt || !String(spec.prompt).trim()) throw Object.assign(new Error('prompt is required'), { status: 400 });
    if (!hasClaude()) throw Object.assign(new Error('claude is not on PATH. Install Claude Code to run headless prompts: https://docs.claude.com/claude-code'), { status: 424 });
    file = 'claude';
    args = ['-p', String(spec.prompt), '--permission-mode', HEADLESS.permissionMode, '--allowedTools', ...HEADLESS.allowed, '--disallowedTools', ...HEADLESS.disallowed];
  } else if (spec.kind === 'command' && Array.isArray(spec.cmd) && spec.cmd.length) {
    [file, ...args] = spec.cmd.map(String);
  } else {
    throw Object.assign(new Error('run needs a prompt or a command'), { status: 400 });
  }

  const id = `${stamp()}-${randomId(2)}`;
  fs.mkdirSync(p.runs, { recursive: true });
  const record = { id, kind: spec.kind, ...(meta.routine ? { routine: meta.routine } : {}), title: meta.title || (spec.prompt ? String(spec.prompt).slice(0, 80) : spec.cmd.join(' ')), ...(spec.prompt ? { prompt: spec.prompt } : { cmd: spec.cmd }), startedAt: nowIso(), endedAt: null, exit: null, status: 'running' };
  const jsonPath = path.join(p.runs, `${id}.json`);
  const logPath = path.join(p.runs, `${id}.log`);
  writeJson(jsonPath, record);
  writeJson(lockFile(p), { pid: process.pid, id });
  const log = fs.openSync(logPath, 'a');
  let written = 0;
  const write = (chunk) => {
    if (written >= CAP) return;
    const buf = chunk.subarray(0, CAP - written);
    fs.writeSync(log, buf);
    written += buf.length;
    if (written >= CAP) fs.writeSync(log, '\n[output truncated at 200 KB]\n');
  };

  const done = new Promise((resolve) => {
    let child;
    const finish = (exit, err) => {
      if (record.status !== 'running') return;
      if (err) write(Buffer.from(`\n${err}\n`));
      fs.closeSync(log);
      Object.assign(record, { endedAt: nowIso(), exit, status: exit === 0 ? 'ok' : 'failed' });
      writeJson(jsonPath, record);
      fs.rmSync(lockFile(p), { force: true });
      resolve(record);
    };
    try {
      child = spawn(file, args, { cwd: p.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, FLOWRAIL_RUN: id } });
    } catch (e) {
      return finish(127, e.message);
    }
    const timer = setTimeout(() => child.kill('SIGTERM'), TIMEOUT);
    child.stdout.on('data', write);
    child.stderr.on('data', write);
    child.on('error', (e) => { clearTimeout(timer); finish(127, e.code === 'ENOENT' ? `${file}: command not found` : e.message); });
    child.on('close', (code, signal) => { clearTimeout(timer); finish(code ?? (signal ? 128 : 1), signal ? `killed by ${signal}` : ''); });
  });
  return { id, record, done };
}

export function list(p, limit = 50) {
  return listFiles(p.runs, '.json').reverse().slice(0, limit).map((f) => readJson(path.join(p.runs, f), null)).filter((r) => r && r.id);
}

export function get(p, id) {
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  const r = readJson(path.join(p.runs, `${id}.json`), null);
  if (!r) return null;
  let log = '';
  try { log = fs.readFileSync(path.join(p.runs, `${id}.log`), 'utf8'); } catch { /* no output yet */ }
  return { ...r, log };
}
