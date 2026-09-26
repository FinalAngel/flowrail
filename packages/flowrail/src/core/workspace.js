// Workspace config, version and git state.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, mondayOf } from './util.js';
import { acceptChange } from '../guard/state.js';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;

export const MODULES = ['board', 'docs', 'knowledge', 'memory', 'redlines', 'routines', 'workflows', 'team', 'artifacts'];

export function defaultConfig(name) {
  return {
    name,
    port: 4747,
    modules: Object.fromEntries(MODULES.map((m) => [m, true])),
    sprintLength: 14,
    sprintStart: mondayOf(),
  };
}

export function loadConfig(p) {
  const c = readJson(p.config, {});
  return { ...defaultConfig(path.basename(p.root)), ...c, modules: { ...defaultConfig('').modules, ...(c.modules || {}) } };
}

/** Merge a partial config from the Settings page; validates the fields it knows. */
export function saveConfig(p, patch) {
  const existed = fs.existsSync(p.config);
  const cur = readJson(p.config, {});
  const next = { ...cur };
  const bad = (m) => Object.assign(new Error(m), { status: 400 });
  if (patch.name !== undefined) next.name = String(patch.name).slice(0, 80) || cur.name;
  if (patch.port !== undefined) {
    const port = Number(patch.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw bad('port must be between 1024 and 65535');
    next.port = port;
  }
  if (patch.sprintLength !== undefined) {
    const n = Number(patch.sprintLength);
    if (!Number.isInteger(n) || n < 1 || n > 60) throw bad('sprintLength must be 1 to 60 days');
    next.sprintLength = n;
  }
  if (patch.sprintStart !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.sprintStart)) throw bad('sprintStart must be YYYY-MM-DD');
    next.sprintStart = patch.sprintStart;
  }
  if (patch.setupDismissed !== undefined) next.setupDismissed = !!patch.setupDismissed;
  if (patch.modules !== undefined) {
    next.modules = { ...(cur.modules || {}) };
    for (const [k, v] of Object.entries(patch.modules || {})) if (MODULES.includes(k)) next.modules[k] = !!v;
  }
  writeJson(p.config, next);
  try { acceptChange(p.root, 'config.json', existed ? cur : null, 'settings'); } catch { /* read-only */ }
  return loadConfig(p);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
}

/** { branch, dirty, ahead } or null when git or the repo is missing. */
export function gitInfo(root) {
  try {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const dirty = git(root, ['status', '--porcelain']).split('\n').filter(Boolean).length;
    let ahead = null;
    try { ahead = Number(git(root, ['rev-list', '--count', '@{u}..HEAD'])); } catch { /* no upstream */ }
    return { branch, dirty, ahead };
  } catch {
    return null;
  }
}

export function workspaceInfo(p) {
  const config = loadConfig(p);
  return { name: config.name, root: p.root, version: VERSION, demo: !!config.demo, modules: config.modules };
}
