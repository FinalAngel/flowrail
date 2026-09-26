// Routines: scheduled report-only runs. launchd on macOS, crontab on Linux, instructions elsewhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { readJson, writeJson, readJsonl, appendLine, nowIso, pad, addDays, loadConfig } from 'flowrail/api';
import { PKG_ROOT } from './pkg.js';
import * as runs from './runs.js';

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const EVERY = ['day', 'weekday', 'hour', ...DAYS];
const EVENTS = ['github-actions', 'hook'];
const scheduled = (r) => r && r.on === undefined;
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function load(p) {
  const r = readJson(p.routines, []);
  return Array.isArray(r) ? r : [];
}

export function validate(routines) {
  const errors = [];
  if (!Array.isArray(routines)) return ['routines.json must be a JSON array'];
  const ids = new Set();
  routines.forEach((r, i) => {
    const at = `routine ${i + 1}${r && r.id ? ` (${r.id})` : ''}`;
    if (!r || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id || '')) errors.push(`${at}: id must be a lowercase slug`);
    if (r && ids.has(r.id)) errors.push(`${at}: duplicate id`);
    ids.add(r && r.id);
    if (r && r.on !== undefined) {
      // An event routine: something else runs it (GitHub Actions, a hook). Never scheduled here.
      const on = r.on || {};
      if (!EVENTS.includes(on.event)) errors.push(`${at}: on.event must be one of ${EVENTS.join(', ')}`);
      if (on.event === 'github-actions') {
        if (!/^[\w.-]+\/[\w.-]+$/.test(on.repo || '')) errors.push(`${at}: on.repo must be owner/name`);
        if (!/^[\w.-]+\.ya?ml$/.test(on.workflow || '')) errors.push(`${at}: on.workflow must be a workflow file name like ci.yml`);
      }
      if (r.schedule !== undefined) errors.push(`${at}: an event routine has no schedule`);
      if (r.run === undefined) return;
    } else {
      const s = (r && r.schedule) || {};
      if (!EVERY.includes(s.every)) errors.push(`${at}: schedule.every must be one of ${EVERY.join(', ')}`);
      if (s.every !== 'hour' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s.at || '')) errors.push(`${at}: schedule.at must be HH:MM`);
    }
    const run = (r && r.run) || {};
    if (run.type === 'claude' && !run.prompt) errors.push(`${at}: run.prompt is required`);
    else if (run.type === 'command' && !(Array.isArray(run.cmd) && run.cmd.length)) errors.push(`${at}: run.cmd must be an argv array`);
    else if (!['claude', 'command'].includes(run.type)) errors.push(`${at}: run.type must be claude or command`);
  });
  return errors;
}

export function save(p, routines) {
  const errors = validate(routines);
  if (errors.length) throw bad(errors.join('; '));
  writeJson(p.routines, routines);
  return routines;
}

/**
 * Save from the dashboard: merge by id. Routines the request does not name stay as they are, so a
 * stale page never drops one; removing one is `deleteFromApi`. Command routines run programs, so
 * they are file-only: the API may reschedule or disable one that is already in routines.json, but
 * never add one or change what it runs.
 */
export function saveFromApi(p, routines) {
  if (!Array.isArray(routines)) throw bad('routines must be an array');
  const merged = new Map(load(p).map((r) => [r && r.id, r]));
  for (const r of routines) {
    const was = r && merged.get(r.id);
    const command = r?.run?.type === 'command' || was?.run?.type === 'command';
    if (command && JSON.stringify(was?.run) !== JSON.stringify(r?.run)) {
      throw bad('Command routines are edited in flowrail/routines.json only, never over the API. The dashboard can add and change claude routines.', 403);
    }
    merged.set(r && r.id, r);
  }
  return save(p, [...merged.values()]);
}

/** Remove one routine by id: the only way the API deletes one. */
export function deleteFromApi(p, id) {
  const all = load(p);
  if (!all.some((r) => r && r.id === id)) throw bad(`no routine ${id}`, 404);
  return save(p, all.filter((r) => !r || r.id !== id));
}

/** Enabled command routines, which `routines install` shows before scheduling. */
export const commandRoutines = (p) => load(p).filter((r) => scheduled(r) && r.enabled !== false && r.run && r.run.type === 'command');

const cap = (s) => s[0].toUpperCase() + s.slice(1);

/** "Mondays 07:00", "Weekdays 08:30", "Every day 18:00", "Every hour at :15" */
export function describeSchedule(s = {}) {
  const at = s.at || '00:00';
  if (s.every === 'hour') return `Every hour at :${at.split(':')[1] || '00'}`;
  if (s.every === 'day') return `Every day ${at}`;
  if (s.every === 'weekday') return `Weekdays ${at}`;
  if (DAYS.includes(s.every)) return `${cap(s.every)}s ${at}`;
  return 'Not scheduled';
}

export function nextRun(s = {}, now = new Date()) {
  const [h, m] = String(s.at || '00:00').split(':').map(Number);
  if (s.every === 'hour') {
    const d = new Date(now);
    d.setMinutes(m || 0, 0, 0);
    if (d <= now) d.setHours(d.getHours() + 1);
    return d.toISOString();
  }
  for (let i = 0; i <= 7; i++) {
    const d = addDays(new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m), i);
    if (d <= now) continue;
    const dow = d.getDay();
    if (s.every === 'day' || (s.every === 'weekday' && dow >= 1 && dow <= 5) || DAYS[dow] === s.every) return d.toISOString();
  }
  return null;
}

export function lastRuns(p) {
  const last = {};
  for (const e of readJsonl(p.routinesLog)) last[e.id] = e;
  return last;
}

const hash = (root) => crypto.createHash('sha1').update(root).digest('hex').slice(0, 8);
const label = (root, id) => `dev.flowrail.${hash(root)}.${id}`;
const agentsDir = () => path.join(os.homedir(), 'Library', 'LaunchAgents');

function crontabLines() {
  try {
    const r = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 3000 });
    return r.status === 0 ? r.stdout.split('\n') : [];
  } catch { return []; }
}

function installedIds(p) {
  const ids = new Set();
  if (process.platform === 'darwin') {
    const prefix = `dev.flowrail.${hash(p.root)}.`;
    try { for (const f of fs.readdirSync(agentsDir())) if (f.startsWith(prefix) && f.endsWith('.plist')) ids.add(f.slice(prefix.length, -6)); } catch { /* none */ }
  } else if (process.platform === 'linux') {
    const marker = `# flowrail:${hash(p.root)}:`;
    for (const l of crontabLines()) { const i = l.indexOf(marker); if (i !== -1) ids.add(l.slice(i + marker.length).trim()); }
  }
  return ids;
}

/**
 * The routines the pages show and run: a plugin's store when one is set (`stores.routines`: list()
 * and runNow(id)), else flowrail/routines.json. A store's routines are scheduled by the repo's own
 * tooling, so installing, saving and deleting them here is refused.
 */
export const routinesFor = (p) => p.stores?.routines || null;

export function list(p, now = new Date()) {
  if (routinesFor(p)) return routinesFor(p).list();
  const last = lastRuns(p);
  const installed = installedIds(p);
  return load(p).map((r) => ({
    ...r,
    enabled: r.enabled !== false,
    scheduleText: scheduled(r) ? describeSchedule(r.schedule) : describeEvent(r.on),
    installed: scheduled(r) ? installed.has(r.id) : null,
    lastRun: last[r.id] ? { at: last[r.id].at, exit: last[r.id].exit, run: last[r.id].run || null, firstLine: last[r.id].firstLine || '' } : null,
    next: r.enabled === false || !scheduled(r) ? null : nextRun(r.schedule, now),
  }));
}

/** "On GitHub Actions: ci.yml", "When a hook runs it" */
export function describeEvent(on = {}) {
  if (on.event === 'github-actions') return `On GitHub Actions: ${on.workflow}`;
  return 'When something else runs it';
}

const GH_TTL = 5 * 60000;
const ghCache = (p) => path.join(p.local, 'github-runs.json');

/** gh as a promise; tests pass their own. Resolves stdout, rejects on any failure or timeout. */
export const ghExec = (args) => new Promise((resolve, reject) => {
  execFile('gh', args, { timeout: 8000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

/**
 * The last runs of every GitHub Actions routine, read-only through `gh run list`, cached for five
 * minutes in .flowrail/github-runs.json. The demo reads the cache only and never calls gh.
 * @returns {Promise<Object<string, {runs?: object[], error?: string, at: string}>>} by routine id
 */
export async function githubRuns(p, { exec = ghExec, now = Date.now() } = {}) {
  const cache = readJson(ghCache(p), {});
  const demo = !!loadConfig(p).demo;
  const out = {};
  let dirty = false;
  for (const r of load(p).filter((x) => x && x.on && x.on.event === 'github-actions')) {
    const key = `${r.on.repo}/${r.on.workflow}`;
    const hit = cache[key];
    if (hit && (demo || now - Date.parse(hit.at) < GH_TTL)) { out[r.id] = hit; continue; }
    if (demo) { out[r.id] = { error: 'GitHub unavailable', at: new Date(now).toISOString() }; continue; }
    try {
      const raw = await exec(['run', 'list', '--repo', r.on.repo, '--workflow', r.on.workflow, '--limit', '5', '--json', 'status,conclusion,createdAt,displayTitle,headBranch,url']);
      const runs = JSON.parse(raw).map((x) => ({ status: x.status, conclusion: x.conclusion || null, at: x.createdAt, title: x.displayTitle, branch: x.headBranch, url: /^https:\/\/github\.com\//.test(x.url || '') ? x.url : null }));
      out[r.id] = cache[key] = { runs, at: new Date(now).toISOString() };
    } catch {
      out[r.id] = cache[key] = { error: 'GitHub unavailable', at: new Date(now).toISOString() };
    }
    dirty = true;
  }
  if (dirty) writeJson(ghCache(p), cache);
  return out;
}

const BIN = path.join(PKG_ROOT, 'bin', 'flowrail-room.js');
const argv = (root, id) => [process.execPath, BIN, 'routines', 'run', id];

export function plistFor(p, r) {
  const s = r.schedule;
  const [h, m] = String(s.at || '00:00').split(':').map(Number);
  const dict = (o) => `<dict>${Object.entries(o).map(([k, v]) => `<key>${k}</key><integer>${v}</integer>`).join('')}</dict>`;
  let cal;
  if (s.every === 'hour') cal = dict({ Minute: m || 0 });
  else if (s.every === 'day') cal = dict({ Hour: h, Minute: m });
  else if (s.every === 'weekday') cal = `<array>${[1, 2, 3, 4, 5].map((d) => dict({ Weekday: d, Hour: h, Minute: m })).join('')}</array>`;
  else cal = dict({ Weekday: DAYS.indexOf(s.every), Hour: h, Minute: m });
  const esc = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label(p.root, r.id)}</string>
<key>ProgramArguments</key><array>${argv(p.root, r.id).map((a) => `<string>${esc(a)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${esc(p.root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${esc(process.env.PATH || '/usr/bin:/bin')}</string></dict>
<key>StartCalendarInterval</key>${cal}
<key>StandardOutPath</key><string>${esc(path.join(p.runs, 'scheduler.log'))}</string>
<key>StandardErrorPath</key><string>${esc(path.join(p.runs, 'scheduler.log'))}</string>
</dict></plist>
`;
}

export function cronLineFor(p, r) {
  const s = r.schedule;
  const [h, m] = String(s.at || '00:00').split(':').map(Number);
  const dow = s.every === 'weekday' ? '1-5' : DAYS.includes(s.every) ? DAYS.indexOf(s.every) : '*';
  const when = s.every === 'hour' ? `${m || 0} * * * *` : `${m} ${h} * * ${dow}`;
  const q = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;
  const cmd = argv(p.root, r.id).map(q).join(' ');
  return `${when} cd ${q(p.root)} && PATH=${q(process.env.PATH || '/usr/bin:/bin')} ${cmd} >> ${q(path.join(p.runs, 'scheduler.log'))} 2>&1 # flowrail:${hash(p.root)}:${r.id}`;
}

/**
 * Install every enabled routine for this workspace (replacing earlier installs).
 * From the API (opts.http) command routines are refused: a routines.json from a clone must never
 * schedule a program without the human seeing its argv in the terminal first.
 */
export function install(p, opts = {}) {
  const routines = load(p).filter((r) => scheduled(r) && r.enabled !== false);
  const errors = validate(load(p));
  if (errors.length) throw bad(errors.join('; '));
  if (opts.http && commandRoutines(p).length) {
    throw bad(`Command routines (${commandRoutines(p).map((r) => r.id).join(', ')}) are scheduled from the terminal, where you see each command first: npx @finalangel/flowrail-room routines install`, 403);
  }
  uninstall(p);
  fs.mkdirSync(p.runs, { recursive: true });
  if (process.platform === 'darwin') {
    fs.mkdirSync(agentsDir(), { recursive: true });
    for (const r of routines) {
      const file = path.join(agentsDir(), `${label(p.root, r.id)}.plist`);
      fs.writeFileSync(file, plistFor(p, r));
      launchctl(['bootstrap', `gui/${process.getuid()}`, file]) || launchctl(['load', '-w', file]);
    }
    return { platform: 'launchd', installed: routines.map((r) => r.id) };
  }
  if (process.platform === 'linux') {
    const kept = crontabLines().filter((l) => !l.includes(`# flowrail:${hash(p.root)}:`));
    const next = [...kept.filter((l, i) => l || i < kept.length - 1), ...routines.map((r) => cronLineFor(p, r))].join('\n') + '\n';
    writeCrontab(next);
    return { platform: 'cron', installed: routines.map((r) => r.id) };
  }
  return {
    platform: process.platform,
    installed: [],
    instructions: routines.map((r) => `${describeSchedule(r.schedule)}: run "${argv(p.root, r.id).join(' ')}" in ${p.root}`),
  };
}

export function uninstall(p) {
  const removed = [];
  if (process.platform === 'darwin') {
    const prefix = `dev.flowrail.${hash(p.root)}.`;
    let files = [];
    try { files = fs.readdirSync(agentsDir()).filter((f) => f.startsWith(prefix) && f.endsWith('.plist')); } catch { /* none */ }
    for (const f of files) {
      const file = path.join(agentsDir(), f);
      launchctl(['bootout', `gui/${process.getuid()}`, file]) || launchctl(['unload', file]);
      fs.rmSync(file, { force: true });
      removed.push(f.slice(prefix.length, -6));
    }
  } else if (process.platform === 'linux') {
    const lines = crontabLines();
    const marker = `# flowrail:${hash(p.root)}:`;
    const kept = lines.filter((l) => { if (l.includes(marker)) { removed.push(l.split(marker)[1]); return false; } return true; });
    if (removed.length) writeCrontab(kept.join('\n').replace(/\n*$/, '\n'));
  }
  return { removed };
}

function launchctl(args) {
  try { execFileSync('launchctl', args, { stdio: 'ignore', timeout: 5000 }); return true; } catch { return false; }
}

function writeCrontab(text) {
  const r = spawnSync('crontab', ['-'], { input: text, encoding: 'utf8', timeout: 5000 });
  if (r.status !== 0) throw bad(`crontab failed: ${(r.stderr || '').trim() || 'is cron installed?'}`, 500);
}

export function status(p) {
  return list(p).map((r) => ({ id: r.id, title: r.title, schedule: r.scheduleText, enabled: r.enabled, installed: r.installed, lastRun: r.lastRun, next: r.next }));
}

/**
 * Run one routine now. Report routines are told to write an HTML artifact.
 * @returns {Promise<object>} the finished run record
 */
export async function runNow(p, id, { wait = true } = {}) {
  const r = load(p).find((x) => x.id === id);
  if (!r) throw bad(`no routine ${id}`, 404);
  if (!r.run) throw bad(`${r.title || r.id} is run by ${describeEvent(r.on).toLowerCase()}, not from here`, 409);
  const d = new Date();
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const spec = r.run.type === 'claude'
    ? { kind: 'claude', prompt: r.report === false ? r.run.prompt : `${r.run.prompt}\n\nWrite your report as one self-contained HTML file to flowrail/artifacts/${r.id}-${day}.html (inline CSS, no external requests). Do not change any other file.` }
    : { kind: 'command', cmd: r.run.cmd };
  let started;
  try {
    started = runs.start(p, spec, { routine: r.id, title: r.title });
  } catch (e) {
    appendLine(p.routinesLog, { id: r.id, at: nowIso(), exit: 1, firstLine: e.message.slice(0, 200) });
    throw e;
  }
  const finish = started.done.then((rec) => {
    const log = runs.get(p, rec.id)?.log || '';
    const firstLine = rec.exit === 0 ? '' : (log.split('\n').find((l) => l.trim()) || '').slice(0, 200);
    appendLine(p.routinesLog, { id: r.id, at: rec.endedAt, exit: rec.exit, run: rec.id, ...(firstLine ? { firstLine } : {}) });
    return rec;
  });
  return wait ? finish : started.record;
}

/** The control room's doctor check (the guard's doctor knows nothing about routines). */
export function doctorChecks(p) {
  const check = (status, detail, fix = '') => [{ id: 'routines', title: 'Routines', status, ok: status === 'ok', level: status, detail, ...(fix ? { fix } : {}) }];
  try {
    const errors = validate(readJson(p.routines, []));
    return check(errors.length ? 'fail' : 'ok', errors.length ? errors.join('; ') : 'routines.json is valid', errors.length ? 'Fix flowrail/routines.json' : '');
  } catch (e) { return check('fail', e.message, 'Fix flowrail/routines.json'); }
}
