// GitHub issues on the board, read-only. flowrail/config.json "github": { "repo": "owner/name",
// "assignee": "@me" } turns it on (file only: the settings API cannot set it). The server asks the
// `gh` CLI (no shell, a timeout, JSON out) and keeps the answer for five minutes in
// .flowrail/github-issues.json. Nothing is ever written back to GitHub. The demo reads a seeded
// cache and never runs gh.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { readJson, writeJson } from 'flowrail/api';

export const TTL = 5 * 60 * 1000;
const FIELDS = 'number,title,url,state,closedAt,updatedAt,labels,assignees';
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const USER_RE = /^@?[\w-]+$/;

export const cacheFile = (p) => path.join(p.local, 'github-issues.json');

/** The configured repo and assignee, or null when GitHub is not set up (or set up wrongly). */
export function settings(config) {
  const g = config && config.github;
  if (!g || typeof g !== 'object' || !REPO_RE.test(String(g.repo || ''))) return null;
  const assignee = g.assignee === undefined ? '@me' : String(g.assignee);
  return USER_RE.test(assignee) ? { repo: g.repo, assignee } : null;
}

/** Run gh and parse its JSON. `run` is injectable for tests. */
export function ghRunner(args) {
  return new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: 15000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

const shape = (i) => ({
  number: i.number, title: String(i.title || ''), url: String(i.url || ''), state: String(i.state || '').toUpperCase(),
  closedAt: i.closedAt || null, updatedAt: i.updatedAt || null,
  labels: (i.labels || []).map((l) => l.name || l).filter(Boolean).slice(0, 5),
  assignees: (i.assignees || []).map((a) => a.login || a).filter(Boolean),
});

/**
 * { available, repo, issues, at, error? }, or null when GitHub is not configured.
 * A cache younger than TTL (or any cache in the demo) is used as is; a failed gh call is not cached.
 */
export async function fetchIssues(p, config, { run = ghRunner, now = Date.now(), force = false } = {}) {
  const s = settings(config);
  if (!s) return null;
  const cached = readJson(cacheFile(p), null);
  const fresh = cached && cached.repo === s.repo && Array.isArray(cached.issues) && (config.demo || (!force && now - Date.parse(cached.at) < TTL));
  if (fresh) return { available: true, repo: s.repo, issues: cached.issues, at: cached.at };
  if (config.demo) return { available: false, repo: s.repo, issues: [], error: 'GitHub unavailable' };
  try {
    const out = await run(['issue', 'list', '--repo', s.repo, '--assignee', s.assignee, '--state', 'all', '--limit', '100', '--json', FIELDS]);
    const issues = JSON.parse(out).map(shape);
    const at = new Date(now).toISOString();
    try { writeJson(cacheFile(p), { repo: s.repo, at, issues }); } catch { /* the board still shows them */ }
    return { available: true, repo: s.repo, issues, at };
  } catch {
    return { available: false, repo: s.repo, issues: [], error: 'GitHub unavailable' };
  }
}

/** The issues that belong to a sprint: every open one, and those closed between its start and end. */
export function forSprint(issues, sprint) {
  if (!sprint) return [];
  const end = new Date(`${sprint.end}T23:59:59.999`).getTime();
  const start = new Date(`${sprint.start}T00:00:00`).getTime();
  return issues.filter((i) => {
    if (i.state !== 'CLOSED') return true;
    const t = Date.parse(i.closedAt);
    return t >= start && t <= end;
  });
}
