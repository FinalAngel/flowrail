// Team: Claude Code subagents in .claude/agents, skills in .claude/skills, slash commands in .claude/commands.
// state: running | done (finished in the last hour) | idle. Live state comes from the SubagentStart/SubagentStop hooks (.flowrail/agents/<name>.json).
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import { listFiles, readText, readJson } from 'flowrail/api';

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

export function team(p) {
  return { agents: agents(p), skills: skills(p), commands: commands(p) };
}
