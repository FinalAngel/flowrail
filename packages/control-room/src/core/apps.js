// Applications: local programs listed in flowrail/config.json "apps" (a docs site, a slide deck, a
// preview server). The list is file-only, like command routines: the API starts and stops an app by
// id and can never add one or change what it runs. Each app runs detached, without a shell, in its
// own process group; its output goes to .flowrail/apps/<id>.log and its pid to <id>.pid.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from 'flowrail/api';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const dir = (p) => path.join(p.local, 'apps');
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

/** Problems with an "apps" array, as sentences; [] when it is fine. */
export function validate(apps) {
  if (apps === undefined) return [];
  if (!Array.isArray(apps)) return ['apps must be a JSON array'];
  const errors = [];
  const ids = new Set();
  apps.forEach((a, i) => {
    const at = `app ${i + 1}${a && a.id ? ` (${a.id})` : ''}`;
    if (!a || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.id || '')) errors.push(`${at}: id must be a lowercase slug`);
    else if (ids.has(a.id)) errors.push(`${at}: duplicate id`);
    if (a) ids.add(a.id);
    if (!a || typeof a.name !== 'string' || !a.name.trim()) errors.push(`${at}: name is required`);
    if (!a || !Array.isArray(a.cmd) || !a.cmd.length || !a.cmd.every((w) => typeof w === 'string' && w)) errors.push(`${at}: cmd must be an argv array, for example ["npm", "run", "docs"]`);
    if (a && a.cwd !== undefined && (typeof a.cwd !== 'string' || path.isAbsolute(a.cwd) || a.cwd.split(/[\\/]/).includes('..'))) errors.push(`${at}: cwd must be a folder inside the repo`);
    if (a && a.url !== undefined && !/^https?:\/\/[^\s]+$/.test(String(a.url))) errors.push(`${at}: url must be http or https`);
  });
  return errors;
}

function configured(p) {
  const apps = loadConfig(p).apps;
  const errors = validate(apps);
  if (errors.length) throw bad(`flowrail/config.json: ${errors.join('; ')}`, 422);
  return apps || [];
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function pidOf(p, id) {
  const file = path.join(dir(p), `${id}.pid`);
  const pid = Number(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 0);
  if (pid && alive(pid)) return pid;
  fs.rmSync(file, { force: true });
  return null;
}

/** Only a loopback URL is probed: the dashboard never reaches out to another host. */
async function reachable(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!LOOPBACK.has(u.hostname)) return null;
  try { await fetch(u, { signal: AbortSignal.timeout(800), redirect: 'manual' }); return true; } catch { return false; }
}

export async function list(p) {
  return Promise.all(configured(p).map(async (a) => {
    const pid = pidOf(p, a.id);
    return { id: a.id, name: a.name, cmd: a.cmd, cwd: a.cwd || '.', url: a.url || null, running: !!pid, pid, reachable: pid && a.url ? await reachable(a.url) : null };
  }));
}

export function start(p, id) {
  const a = configured(p).find((x) => x.id === id);
  if (!a) throw bad(`no app ${id} in flowrail/config.json`, 404);
  if (pidOf(p, id)) throw bad(`${a.name} is already running`, 409);
  const cwd = path.resolve(p.root, a.cwd || '.');
  if (cwd !== p.root && !cwd.startsWith(p.root + path.sep)) throw bad('cwd must be inside the repo');
  fs.mkdirSync(dir(p), { recursive: true });
  const log = fs.openSync(path.join(dir(p), `${id}.log`), 'a');
  fs.writeSync(log, `\n--- ${new Date().toISOString()} ${a.cmd.join(' ')}\n`);
  let child;
  try {
    child = spawn(a.cmd[0], a.cmd.slice(1), { cwd, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FLOWRAIL_APP: id } });
  } finally { fs.closeSync(log); }
  // A missing program is reported on the next status read: the pid is gone by then.
  child.on('error', (e) => fs.appendFileSync(path.join(dir(p), `${id}.log`), `${a.cmd[0]}: ${e.code === 'ENOENT' ? 'command not found' : e.message}\n`));
  child.unref();
  if (child.pid) fs.writeFileSync(path.join(dir(p), `${id}.pid`), String(child.pid));
  return { id, running: !!child.pid, pid: child.pid || null };
}

export function stop(p, id) {
  if (!configured(p).some((x) => x.id === id)) throw bad(`no app ${id} in flowrail/config.json`, 404);
  const pid = pidOf(p, id);
  if (!pid) return { id, running: false };
  try { process.kill(-pid, 'SIGTERM'); } catch { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
  fs.rmSync(path.join(dir(p), `${id}.pid`), { force: true });
  return { id, running: false };
}

/** The last 20 KB of an app's output. */
export function log(p, id) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return '';
  try {
    const text = fs.readFileSync(path.join(dir(p), `${id}.log`), 'utf8');
    return text.slice(-20 * 1024);
  } catch { return ''; }
}
