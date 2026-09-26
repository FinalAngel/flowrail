// Live dashboard ports in <stateDir>/ports.json ({ports, updated}), so the guard knows which
// loopback ports are a flowrail dashboard and holds HTTP clients aimed at them.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { stateDir } from 'flowrail/api';

export const portsFile = () => path.join(stateDir(), 'ports.json');

function read() {
  try {
    const ports = JSON.parse(fs.readFileSync(portsFile(), 'utf8')).ports;
    return Array.isArray(ports) ? ports.filter(Number.isInteger) : [];
  } catch { return []; }
}

function write(ports) {
  const file = portsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ports: [...new Set(ports)].sort((a, b) => a - b), updated: new Date().toISOString() }) + '\n');
  fs.renameSync(tmp, file);
}

/** Something listens on 127.0.0.1:port. */
export function answers(port, timeout = 300) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Add our port; drop entries from instances that no longer answer. */
export async function registerPort(port) {
  const others = read().filter((x) => x !== port);
  const alive = await Promise.all(others.map((x) => answers(x)));
  write([...others.filter((_, i) => alive[i]), port]);
}

/** Take our port out again (sync, so it runs in a signal handler). */
export function unregisterPort(port) {
  try { write(read().filter((x) => x !== port)); } catch { /* state dir gone; nothing to clean */ }
}
