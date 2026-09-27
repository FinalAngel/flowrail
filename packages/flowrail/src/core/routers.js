// Router lint for `flowrail check`: when a workspace has areas, every router exists and stays under
// a page, every repo path it names resolves, and every top-level folder (and every folder under
// config `routers.roots`) is reachable from CLAUDE.md or a router, so an agent that starts at
// CLAUDE.md finds it in two hops. A stale pointer is worse than none.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { areaList, mentions, head } from './areas.js';

const SKIP = new Set(['.git', 'node_modules', '.flowrail']);
const DOT_OK = new Set(['.claude', '.github', '.githooks']);
const EXT = /\.(md|markdown|mdx|txt|json|ya?ml|toml|csv|html|js|mjs|cjs|ts|tsx|jsx|sh|py|rb|go|rs|sql)$/i;

/** Repo files, tracked and untracked but not ignored; the folder walk when git is not there. */
function repoFiles(root) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 })
      .split('\n').filter(Boolean);
  } catch {
    const out = [];
    const walk = (rel, depth) => {
      let names = [];
      try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return; }
      for (const e of names) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP.has(e.name) && depth < 2) walk(r, depth + 1); } else out.push(r);
      }
    };
    walk('', 0);
    return out;
  }
}

/**
 * The paths a router names on purpose: every link target, and `code` spans that read as a path from
 * the repo root (a slash, and a first segment that exists next to CLAUDE.md or the router). A bare
 * `os.ts` or a `models/` relative to something else in the sentence is prose, not a pointer.
 */
function pointers(text, isTop) {
  const out = new Set();
  const usable = (raw) => {
    const r = String(raw).replace(/[#?].*$/, '').replace(/[.,;:)]+$/, '');
    return !r || /^[a-z]+:/i.test(r) || r.startsWith('/') || /[*<>{}$|]/.test(r) || r.startsWith('-') ? null : r;
  };
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) { const r = usable(m[1]); if (r && (r.includes('/') || EXT.test(r))) out.add(r); }
  for (const m of text.matchAll(/`([^`\s]+)`/g)) { const r = usable(m[1]); if (r && r.includes('/') && isTop(r.split('/')[0])) out.add(r); }
  return out;
}

/**
 * Problems as [{ file, message }], or null when the workspace has no areas (nothing to check).
 * config.routers: { maxWords = 600, roots = [] }.
 */
export function routerProblems(root, config = {}) {
  const list = areaList(root, config);
  if (!list.length) return null;
  const maxWords = Number(config.routers?.maxWords) || 600;
  const roots = (Array.isArray(config.routers?.roots) ? config.routers.roots : []).map((r) => String(r).replace(/^\.\/|\/+$/g, ''));
  const problems = [];
  const named = new Set();
  const exists = (rel) => { try { fs.statSync(path.join(root, rel)); return true; } catch { return false; } };

  const claude = head(path.join(root, 'CLAUDE.md'));
  for (const m of mentions(claude, 'CLAUDE.md')) named.add(m.replace(/\/$/, ''));
  for (const { router } of list) {
    const rel = router.replace(/^\.\//, '');
    if (!exists(rel)) { problems.push({ file: rel, message: 'router is missing' }); continue; }
    named.add(rel);
    const text = head(path.join(root, rel), 1024 * 1024);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words > maxWords) problems.push({ file: rel, message: `${words} words, a router stays under a page (${maxWords})` });
    for (const m of mentions(text, rel)) named.add(m.replace(/\/$/, ''));
    const dir = path.posix.dirname(rel);
    const isTop = (seg) => seg === '.' || seg === '..' || exists(seg) || exists(path.posix.join(dir, seg));
    for (const p of pointers(text, isTop)) {
      const candidates = [path.posix.normalize(path.posix.join(dir, p)), path.posix.normalize(p)].filter((c) => !c.startsWith('..'));
      if (!candidates.some(exists)) problems.push({ file: rel, message: `names ${p}, which does not exist` });
    }
  }

  // Folders an agent must be able to reach: every top-level folder, and the folders under each root.
  const files = repoFiles(root);
  const folders = new Set();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length < 2) continue;
    const top = parts[0];
    if (SKIP.has(top) || (top.startsWith('.') && !DOT_OK.has(top))) continue;
    folders.add(top);
    for (const r of roots) {
      const rp = r.split('/');
      if (parts.length > rp.length + 1 && rp.every((x, i) => parts[i] === x)) folders.add(parts.slice(0, rp.length + 1).join('/'));
    }
  }
  const reachable = (t) => [...named].some((m) => m === t || m.startsWith(t + '/') || t.startsWith(m + '/'));
  for (const t of [...folders].sort()) if (!reachable(t)) problems.push({ file: `${t}/`, message: 'reachable from no router (add a line to the area it belongs to)' });
  return problems;
}
