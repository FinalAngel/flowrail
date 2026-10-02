// Every skill and slash command Claude Code can use in this repo, from the three places they live:
// the project (.claude/skills, .claude/commands), the person (<config>/skills and commands, where
// <config> is $CLAUDE_CONFIG_DIR or ~/.claude) and each enabled plugin (its installPath, from
// <config>/plugins/installed_plugins.json, enabled in either settings.json). Built-in commands
// (/init, /loop) have no file and are not listed. Read only; nothing outside the repo is served.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { readJson, readText } from 'flowrail/api';

const dirs = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() || e.isSymbolicLink()).map((e) => e.name); } catch { return []; } };
const files = (dir) => { try { return fs.readdirSync(dir).filter((n) => n.endsWith('.md')); } catch { return []; } };
const real = (f) => { try { return fs.realpathSync(f); } catch { return f; } };
/** A folded or literal YAML block (`description: >`), which parseFrontmatter leaves as ">": its indented lines. */
function block(text, key) {
  const m = new RegExp(`^${key}:\\s*[>|][+-]?\\s*\\n((?:[ \\t]+.*\\n?|\\s*\\n)+)`, 'm').exec(text);
  return m ? m[1].replace(/\s+/g, ' ').trim() : '';
}
const desc = (data, body, text) => String((/^[>|][+-]?$/.test(String(data.description || '').trim()) ? block(text, 'description') : data.description)
  || body.trim().split('\n').find((l) => l.trim() && !l.startsWith('#')) || '').replace(/\s+/g, ' ').trim().slice(0, 400);

/** Skills (<dir>/skills/<name>/SKILL.md) and commands (<dir>/commands/<name>.md) under one base. */
function scan(base, source, { prefix = '', plugin, root } = {}) {
  const out = [];
  const add = (file, fallback, kind) => {
    const text = readText(file);
    if (!text) return;
    const { data, body } = parseFrontmatter(text);
    const name = `${kind === 'command' ? '/' : ''}${prefix}${data.name || fallback}`;
    const rel = root && real(file).startsWith(real(root) + path.sep) ? path.relative(real(root), real(file)) : null;
    out.push({ name, description: desc(data, body, text), kind, source, ...(plugin ? { plugin } : {}), ...(rel ? { path: rel.split(path.sep).join('/') } : {}), file: real(file) });
  };
  for (const d of dirs(path.join(base, 'skills'))) add(path.join(base, 'skills', d, 'SKILL.md'), d, 'skill');
  for (const f of files(path.join(base, 'commands'))) add(path.join(base, 'commands', f), f.replace(/\.md$/, ''), 'command');
  return out;
}

export const configDir = (env = process.env) => env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** The enabled plugins with where they are installed: [{ name, path }]. */
export function plugins(p, env = process.env) {
  const cfg = configDir(env);
  const enabled = { ...readJson(path.join(cfg, 'settings.json'), {})?.enabledPlugins, ...readJson(path.join(p.root, '.claude', 'settings.json'), {})?.enabledPlugins };
  const installed = readJson(path.join(cfg, 'plugins', 'installed_plugins.json'), {})?.plugins || {};
  const out = [];
  for (const [id, entries] of Object.entries(installed)) {
    if (enabled[id] !== true || !Array.isArray(entries)) continue;
    // A project install for this repo wins over the user install.
    const hit = entries.find((e) => e.scope === 'project' && e.projectPath && real(e.projectPath) === real(p.root)) || entries.find((e) => e.scope === 'user');
    if (hit?.installPath) out.push({ name: id.split('@')[0], path: hit.installPath });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** { skills: [{ name, description, kind, source: project|user|plugin, plugin?, path? }], counts }. */
export function catalog(p, env = process.env) {
  const all = [
    ...scan(path.join(p.root, '.claude'), 'project', { root: p.root }),
    ...scan(configDir(env), 'user', { root: p.root }),
    ...plugins(p, env).flatMap((pl) => scan(pl.path, 'plugin', { prefix: `${pl.name}:`, plugin: pl.name })),
  ];
  // The same file reached twice (a user skill symlinked into the repo) is listed once, as the project's.
  const seen = new Set();
  const skills = all.filter((s) => !seen.has(s.file) && seen.add(s.file)).map(({ file, ...s }) => s)
    .sort((a, b) => a.name.localeCompare(b.name));
  const counts = { project: 0, user: 0, plugin: 0 };
  for (const s of skills) counts[s.source]++;
  return { skills, counts };
}
