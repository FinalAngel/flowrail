// File watching for live refresh. Emits an area name ("board", "comments", ...) after a 150 ms debounce.
// Uses recursive fs.watch where the platform supports it, else polls every 2 s.
import fs from 'node:fs';
import path from 'node:path';

export function areaFor(rel) {
  const r = rel.split(path.sep).join('/');
  if (r === 'flowrail/board.json' || r === 'flowrail/config.json') return 'board';
  if (r.startsWith('.flowrail/comments')) return 'comments';
  if (r.startsWith('flowrail/memory')) return 'memory';
  if (r === 'flowrail/red-lines.json' || r.startsWith('.flowrail/redlines') || r.startsWith('.flowrail/check-results')) return 'redlines';
  if (r === 'flowrail/routines.json' || r.startsWith('.flowrail/runs')) return 'routines';
  // An app's pid file says it started or stopped; its log is too chatty to refresh on.
  if (r.startsWith('.flowrail/apps/')) return r.endsWith('.pid') ? 'routines' : null;
  if (r === '.flowrail/github-runs.json') return 'routines';
  if (r.startsWith('flowrail/artifacts')) return 'artifacts';
  if (r.startsWith('.flowrail/agents') || r.startsWith('.claude/')) return 'agents';
  if (r.startsWith('.flowrail/trash')) return null;
  return 'docs';
}

/**
 * @param {string} root
 * @param {(area: string) => void} emit
 * @returns {() => void} stop
 */
export function watch(root, emit) {
  const pending = new Set();
  let timer = null;
  const queue = (rel) => {
    if (!rel) return;
    const area = areaFor(rel);
    if (!area) return;
    pending.add(area);
    clearTimeout(timer);
    timer = setTimeout(() => { for (const a of pending) emit(a); pending.clear(); }, 150);
  };

  const watchers = [];
  const targets = [
    { dir: 'flowrail', recursive: true },
    { dir: '.flowrail', recursive: true },
    { dir: '.claude', recursive: true },
    { dir: '', recursive: false, filter: (f) => /\.(md|markdown)$/i.test(f) },
  ];
  const poll = [];
  for (const t of targets) {
    const abs = path.join(root, t.dir);
    if (!fs.existsSync(abs)) continue;
    try {
      const w = fs.watch(abs, { recursive: t.recursive }, (_ev, file) => {
        if (!file) return queue(t.dir || 'README.md');
        const f = String(file);
        if (t.filter && !t.filter(f)) return;
        queue(t.dir ? `${t.dir}/${f}` : f);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      poll.push(t);
    }
  }

  let interval = null;
  if (poll.length) {
    // Full rescan every 2 s of the few watched folders; fine for flowrail-sized state.
    const snap = new Map();
    const scan = (first) => {
      for (const t of poll) {
        const stack = [t.dir];
        while (stack.length) {
          const rel = stack.pop();
          let entries = [];
          try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
          for (const e of entries) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { if (t.recursive && e.name !== 'trash') stack.push(r); continue; }
            if (t.filter && !t.filter(e.name)) continue;
            let m = 0;
            try { m = fs.statSync(path.join(root, r)).mtimeMs; } catch { continue; }
            if (!first && snap.get(r) !== m) queue(r);
            snap.set(r, m);
          }
        }
      }
    };
    scan(true);
    interval = setInterval(() => scan(false), 2000);
    interval.unref();
  }

  return () => {
    clearTimeout(timer);
    if (interval) clearInterval(interval);
    for (const w of watchers) try { w.close(); } catch { /* already closed */ }
  };
}
