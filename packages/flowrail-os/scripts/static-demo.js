#!/usr/bin/env node
// Builds the read-only demo for GitHub Pages: seeds the example workspace, starts flowrailOS on it,
// saves every answer the pages read as JSON (ui/lib/snapshot.js reads them back), and copies the UI.
//   node packages/flowrail-os/scripts/static-demo.js [outDir=_site]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seed } from '../src/core/demo.js';
import { startServer } from '../src/server.js';
import { searchable } from '../src/core/overview.js';
import { paths } from 'flowrail/api';
import { snapshotFile } from '../ui/lib/snapshot.js';

const UI = path.join(import.meta.dirname, '..', 'ui');
const out = path.resolve(process.argv[2] || '_site');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrail-demo-'));
seed(dir);

// The audit replays the fictional transcripts seeded beside the demo, as `flowrail-os demo` does.
const srv = await startServer({ root: dir, port: 0, auditEnv: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, '.flowrail', 'claude') } });
const fetchApi = async (p) => {
  const res = await fetch(`${srv.url}/api${p}`, { headers: { 'X-Flowrail-Token': srv.token } });
  const data = await res.json().catch(() => null);
  return res.ok ? data : { __error: data?.error || res.statusText, status: res.status };
};
const write = (file, data) => {
  const f = path.join(out, 'api', `${file}.json`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(data));
};
const save = async (p) => {
  const data = await fetchApi(p);
  write(snapshotFile(p), data);
  return data;
};

try {
  fs.rmSync(out, { recursive: true, force: true });
  fs.cpSync(UI, path.join(out, 'ui'), { recursive: true });
  const index = fs.readFileSync(path.join(UI, 'index.html'), 'utf8');
  fs.writeFileSync(path.join(out, 'index.html'), index.replace(/<head[^>]*>/i, (m) => `${m}\n<meta name="flowrail-static" content="1">`));
  fs.writeFileSync(path.join(out, '.nojekyll'), '');

  for (const p of ['overview', 'today', 'audit', 'config', 'board', 'board/issues', 'comments', 'memory', 'redlines', 'graph',
    'workflows', 'routines', 'team', 'reminders', 'links', 'library', 'context', 'actions', 'plugins', 'doctor']) await save('/' + p);
  const automation = await save('/automation');

  const docs = new Set(['flowrail/config.json']);
  const walk = (nodes = []) => nodes.forEach((n) => (n.type === 'file' ? docs.add(n.path) : walk(n.children)));
  walk(await save('/docs/tree'));
  for (const d of docs) { await save(`/docs/file?path=${encodeURIComponent(d)}`); await save(`/comments?path=${encodeURIComponent(d)}`); }

  for (const c of (await save('/records')).collections || []) await save(`/records/${encodeURIComponent(c.id)}`);

  const runs = await save('/runs');
  for (const r of runs) await save(`/runs/${encodeURIComponent(r.id)}`);
  for (const a of automation.apps || []) await save(`/apps/log?id=${encodeURIComponent(a.id)}`);

  for (const a of await save('/artifacts')) {
    const res = await fetch(`${srv.url}/artifacts/${encodeURIComponent(a.name)}`);
    if (!res.ok) continue;
    fs.mkdirSync(path.join(out, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(out, 'artifacts', a.name), await res.text());
  }

  write('search-index', searchable({ ...paths(dir), stores: {} }));
  console.log(`Demo in ${out}: ${docs.size} docs, ${runs.length} runs.`);
} finally {
  await srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
