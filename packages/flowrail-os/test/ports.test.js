import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import './helpers.js'; // FLOWRAIL_STATE_DIR -> a temp folder
import { registerPort, unregisterPort, portsFile } from '../src/core/ports.js';

test('live dashboard ports: merged across instances, dead ones pruned, own port removed on stop', async () => {
  const live = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => live.once('listening', r));
  const other = live.address().port;
  const dead = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const x = s.address().port; s.close(() => r(x)); }); });
  fs.writeFileSync(portsFile(), JSON.stringify({ ports: [other, dead], updated: '' }));
  const mine = other + 1 === dead ? other + 2 : other + 1;
  await registerPort(mine);
  const read = () => JSON.parse(fs.readFileSync(portsFile(), 'utf8'));
  assert.deepEqual(read().ports, [other, mine].sort((a, b) => a - b));
  assert.ok(read().updated);
  unregisterPort(mine);
  assert.deepEqual(read().ports, [other]);
  live.close();
});
