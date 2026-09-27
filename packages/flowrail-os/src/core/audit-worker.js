// The audit replays every recent Claude Code transcript through the red lines, which can take a
// minute on a busy repo. It runs here, off the server's thread, and the answer is kept for ten
// minutes, so the dashboard and every other request stay responsive meanwhile.
import { Worker } from 'node:worker_threads';

const TTL = 10 * 60 * 1000;
const cache = new Map();


/** auditSummary(root, { days, env }) in a worker thread; one run per (root, days) at a time. */
export function auditAsync(root, { days = 30, env = process.env } = {}) {
  const key = `${root}\0${days}`;
  const hit = cache.get(key);
  if (hit && (hit.pending || Date.now() - hit.at < TTL)) return hit.promise;
  const promise = new Promise((resolve, reject) => {
    const w = new Worker(new URL('./audit-thread.js', import.meta.url), { workerData: { root, days, env: { ...env } } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`audit worker exited with ${code}`)); });
  });
  const entry = { promise, pending: true, at: 0 };
  cache.set(key, entry);
  promise.then(() => { entry.pending = false; entry.at = Date.now(); }, () => cache.delete(key));
  return promise;
}
