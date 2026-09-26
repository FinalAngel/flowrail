// The dashboard server (start) and the demo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { out, c, mark } from 'flowrail/api';
import { workspace } from 'flowrail/api';
import { paths } from 'flowrail/api';
import { loadConfig } from 'flowrail/api';
import { startServer } from '../server.js';
import { overview } from '../core/overview.js';
import { cliName } from 'flowrail/api';
import { seed } from '../core/demo.js';
import { readJson } from 'flowrail/api';
import { registerPort, unregisterPort } from '../core/ports.js';
import { fromConfig } from '../core/plugins.js';

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* no browser; the URL is printed */ }
}

async function serve(p, flags, banner, auditEnv) {
  const config = loadConfig(p);
  const want = Number(flags.port) || config.port || 4747;
  const s = await startServer({ root: p.root, port: want, auditEnv, plugins: await fromConfig(p.root, config.plugins) });
  // The guard reads the live ports and holds HTTP clients aimed at them (the API token is in the page).
  await registerPort(s.port).catch(() => {});
  const o = overview(p);
  if (s.port !== want) out(`${mark.warn} Port ${want} is busy, using ${s.port}`);
  out(`${c.bold('flowrail')} ${c.dim('·')} ${config.name}${banner ? c.dim(`  ${banner}`) : ''}`);
  out(`  ${c.cyan(s.url)}`);
  const bits = [];
  bits.push(`${o.counts.commentsOpen} open comment${o.counts.commentsOpen === 1 ? '' : 's'}`);
  bits.push(`${o.counts.inProgress} in progress`);
  bits.push(`held ${o.counts.redlinesHeldWeek} time${o.counts.redlinesHeldWeek === 1 ? '' : 's'} this week`);
  out(`  ${c.dim(bits.join(' · '))}`);
  if (!o.hooks.healthy) out(`  ${mark.warn} ${c.dim(`${o.hooks.problem}; red lines with a hook are not enforced (${cliName()} doctor)`)}`);
  out(c.dim('  Ctrl+C to stop'));
  if (!flags['no-open'] && !process.env.CI) openBrowser(s.url);
  const stop = async () => { await s.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  process.on('exit', () => unregisterPort(s.port));
  return s;
}

export async function start(_pos, flags) {
  return serve(workspace(), flags);
}

/** Remove demo workspaces from earlier runs that are older than a day (only ones flowrail seeded). */
export function cleanOldDemos(tmp = os.tmpdir(), now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(tmp).filter((n) => n === 'flowrail-demo' || n.startsWith('flowrail-demo-')); } catch { return; }
  for (const n of names) {
    const dir = path.join(tmp, n);
    try {
      if (now - fs.statSync(dir).mtimeMs < 86400000) continue;
      if (readJson(path.join(dir, 'flowrail', 'config.json'), {})?.demo !== true) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* in use or gone */ }
  }
}

export async function demo(_pos, flags) {
  cleanOldDemos();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrail-demo-'));
  seed(dir);
  out(`${mark.ok} Example workspace "Paper Plane" in ${c.cyan(dir)}`);
  out(c.dim('  Nothing here touches your repo. Try: cd there and run `npx flowrail redlines test "sudo git push"`'));
  out('');
  // The audit panel replays fictional transcripts seeded next to the demo, never your own sessions.
  return serve(paths(dir), flags, 'example workspace', { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, '.flowrail', 'claude') });
}
