// Team: Claude Code subagents in .claude/agents, skills in .claude/skills, slash commands in .claude/commands.
// state: running | done (finished in the last hour) | idle. Live state comes from the SubagentStart/SubagentStop hooks (.flowrail/agents/<name>.json).
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { listFiles, readText, readJson, loadConfig } from 'flowrail/api';

const WORKING_FOR = 30 * 60000;
const DONE_RECENTLY = 60 * 60000;

function agentState(p, name, now) {
  const s = readJson(path.join(p.agents, `${name.replace(/:/g, '__')}.json`), null);
  if (!s) return { state: 'idle', lastAt: null };
  const age = now - new Date(s.at).getTime();
  if (s.state === 'running' && age < WORKING_FOR) return { state: 'running', lastAt: s.at };
  if (age < DONE_RECENTLY) return { state: 'done', lastAt: s.at };
  return { state: 'idle', lastAt: s.at };
}

const asList = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((s) => s.trim()).filter(Boolean);

export function agents(p, now = Date.now()) {
  const dir = path.join(p.claudeDir, 'agents');
  return listFiles(dir, '.md').map((f) => {
    const { data, body } = parseFrontmatter(readText(path.join(dir, f)));
    const name = data.name || f.replace(/\.md$/, '');
    return {
      name,
      description: String(data.description || body.trim().split('\n')[0] || '').slice(0, 400),
      model: data.model || 'inherit',
      tools: asList(data.tools),
      source: `.claude/agents/${f}`,
      ...agentState(p, name, now),
    };
  });
}

export function skills(p) {
  const dir = path.join(p.claudeDir, 'skills');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
  return entries.map((e) => {
    const rel = `.claude/skills/${e.name}/SKILL.md`;
    const { data } = parseFrontmatter(readText(path.join(p.root, rel)));
    return { name: data.name || e.name, description: String(data.description || '').slice(0, 400), path: rel };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function commands(p) {
  const dir = path.join(p.claudeDir, 'commands');
  return listFiles(dir, '.md').map((f) => {
    const { data, body } = parseFrontmatter(readText(path.join(dir, f)));
    return { name: `/${f.replace(/\.md$/, '')}`, description: String(data.description || body.trim().split('\n')[0] || '').slice(0, 300), path: `.claude/commands/${f}` };
  });
}

/** The rows of the first two-column table in a Markdown body: [{ label, value }] ("| Role | CEO |"). */
export function facts(body) {
  const out = [];
  for (const line of String(body).split('\n')) {
    const m = /^\s*\|([^|]*)\|([^|]*)\|\s*$/.exec(line);
    if (!m) { if (out.length) break; continue; }
    const [label, value] = [m[1].trim(), m[2].trim()];
    if (!label || /^:?-{2,}:?$/.test(label)) continue;
    out.push({ label: label.slice(0, 40), value: value.slice(0, 120) });
  }
  return out.slice(0, 12);
}

/**
 * People: one Markdown profile per person in the folder config "people": { "dir" } names (inside the
 * repo), else flowrail/people/. Frontmatter name (or title, or the first heading), role, email and
 * links; the first paragraph is the bio. A two-column table in the body ("| Role | CEO |") adds
 * facts, and supplies the role and email when the frontmatter does not.
 */
export function people(p) {
  const rel = loadConfig(p).people?.dir;
  const ok = typeof rel === 'string' && rel.trim() && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..');
  const base = ok ? rel.replace(/^\.\/|\/+$/g, '') : 'flowrail/people';
  const dir = path.join(p.root, base);
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  return listFiles(dir, '.md').filter((f) => !/^(readme|index)\.md$/i.test(f)).map((f) => {
    const { data, body } = parseFrontmatter(readText(path.join(dir, f)));
    const links = asList(data.links).filter((l) => /^https?:\/\//i.test(l)).slice(0, 5);
    const bio = body.replace(/^\s*#.*\n/, '').split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^[#>|`-]/.test(x)) || '';
    const rows = facts(body);
    const fact = (re) => rows.find((r) => re.test(r.label))?.value || '';
    const role = str(data.role) || fact(/^role$/i);
    const mail = str(data.email) || fact(/^(e-?mail|work e-?mail)$/i);
    const heading = /^\s*#\s+(.+)$/m.exec(body)?.[1]?.trim();
    return {
      name: str(data.name) || str(data.title) || heading || f.replace(/\.md$/, '').replace(/[-_]+/g, ' '),
      role, email: /^[^\s@]+@[^\s@]+$/.test(mail) ? mail : '', links, bio: bio.slice(0, 400),
      facts: rows.filter((r) => !/^(role|e-?mail|work e-?mail)$/i.test(r.label)), path: `${base}/${f}`,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export function team(p) {
  return { people: people(p), agents: agents(p), skills: skills(p), commands: commands(p) };
}
