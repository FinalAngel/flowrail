import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspace } from './helpers.js';
import { appendJournal, verifyJournal } from '../src/core/journal.js';
import { journalPath } from '../src/guard/state.js';
import { appendLine } from '../src/core/util.js';

/** What the hook does for every decision: the same entry to the repo log and to the journal. */
function record(p, entry) {
  appendLine(p.redlinesLog, entry);
  appendJournal(p.root, entry);
}

const hold = (at, subject) => ({ at, id: 'no-push-without-asking', severity: 'ask', decision: 'ask', tool: 'Bash', subject });

test('an edited journal breaks its hash chain', () => {
  const p = workspace();
  record(p, hold('2026-09-01T10:00:00.000Z', 'git push'));
  record(p, hold('2026-09-01T11:00:00.000Z', 'git push --force'));
  const file = journalPath(p.root);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('--force', '--dry-run'));
  assert.match(verifyJournal(p).problems.join(), /hash chain breaks at entry \d+/);
});

