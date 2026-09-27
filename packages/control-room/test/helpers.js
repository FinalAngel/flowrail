import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planInit, apply } from '../src/core/init.js';
import { paths } from 'flowrail/api';

// Journals and the comment-signing key go to a throwaway folder, never the real per-user state dir.
process.env.FLOWRAIL_STATE_DIR ||= fs.mkdtempSync(path.join(os.tmpdir(), 'flowrail-state-'));

export function tmpdir(prefix = 'flowrail-test-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** A fresh workspace created the same way `flowrail init --yes` does. */
export function workspace(opts = {}) {
  const root = tmpdir();
  apply(root, planInit(root, opts).changes);
  return paths(root);
}

export const BIN = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'bin', 'flowrail-os.js');
