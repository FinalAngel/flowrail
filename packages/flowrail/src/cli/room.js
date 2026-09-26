// `flowrail room [...args]`: hand off to the control room (flowrail-room) when it is installed.
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { out, c } from './ui.js';

/** flowrail-room's entry file, from this project's node_modules or next to this package, else null. */
function roomBin() {
  for (const from of [path.join(process.cwd(), 'noop.js'), import.meta.url]) {
    try { return path.join(path.dirname(createRequire(from).resolve('@finalangel/flowrail-room/package.json')), 'bin', 'flowrail-room.js'); } catch { /* not here */ }
  }
  return null;
}

export async function room(args) {
  const bin = roomBin();
  const r = bin
    ? spawnSync(process.execPath, [bin, ...args], { stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'flowrail-room.cmd' : 'flowrail-room', args, { stdio: 'inherit' });
  if (!r.error) { process.exitCode = r.status ?? 1; return; }
  out(`${args[0] ? `"${args[0]}" is` : 'That is'} a control room command (optional, separate package): ${c.cyan(`npx @finalangel/flowrail-room${args.length ? ' ' + args.join(' ') : ''}`)}`);
  process.exitCode = 1;
}
