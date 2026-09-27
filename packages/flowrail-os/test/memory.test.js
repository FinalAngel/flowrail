import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { store, list, recall, tokenize } from '../src/core/memory.js';
import { workspace } from './helpers.js';

test('store writes a file and the index, and refuses to overwrite', () => {
  const p = workspace({ minimal: true });
  const m = store(p, { fact: 'We deploy on Tuesdays only', type: 'project', name: 'deploy-day', why: 'support is staffed' });
  assert.equal(m.name, 'deploy-day');
  assert.match(fs.readFileSync(path.join(p.memory, 'deploy-day.md'), 'utf8'), /\*\*Why:\*\* support is staffed/);
  assert.match(fs.readFileSync(p.memoryIndex, 'utf8'), /\[deploy-day\]\(deploy-day.md\)/);
  assert.throws(() => store(p, { fact: 'x', type: 'project', name: 'deploy-day' }), { status: 409 });
  assert.ok(store(p, { fact: 'x', type: 'project', name: 'deploy-day', force: true }));
  assert.throws(() => store(p, { fact: 'x', type: 'nope' }), /type/);
  assert.throws(() => store(p, { fact: 'x', type: 'user', name: '../evil' }), /slug/);
});

test('recall ranks the relevant memory first and is deterministic', () => {
  const p = workspace({ minimal: true });
  store(p, { fact: 'Releases stop at the sign-off step; a human publishes to npm', type: 'feedback', name: 'release-signoff' });
  store(p, { fact: 'The default notes folder is ~/Notes', type: 'project', name: 'notes-folder' });
  store(p, { fact: 'Flaky tests are quarantined, never retried', type: 'feedback', name: 'flaky-tests' });
  fs.mkdirSync(path.join(p.root, 'docs'));
  fs.writeFileSync(path.join(p.root, 'docs', 'ci.md'), '# CI\n\n## Retries\n\nWe do not retry flaky tests in CI.\n');
  const hits = recall(p, 'who publishes a release to npm?');
  assert.equal(hits[0].name, 'release-signoff');
  const flaky = recall(p, 'what do we do with flaky tests');
  assert.equal(flaky[0].name, 'flaky-tests');
  assert.ok(flaky.some((h) => h.source === 'doc' && h.path === 'docs/ci.md' && h.heading === 'Retries'));
  assert.deepEqual(recall(p, 'what do we do with flaky tests'), flaky);
  assert.deepEqual(recall(p, 'the and of'), []);
  assert.equal(list(p).length, 3);
});

test('tokenize drops stopwords and stems plurals, -ing and -ed alike', () => {
  assert.deepEqual(tokenize('The releases are publishing'), ['releas', 'publish']);
  for (const [a, b] of [['release', 'released'], ['ship', 'shipping'], ['test', 'tests'], ['schedule', 'scheduling'], ['friday', 'Fridays']]) {
    assert.deepEqual(tokenize(a), tokenize(b), `${a} ~ ${b}`);
  }
});

test('recall finds a fact through a small synonym map', () => {
  const p = workspace({ minimal: true });
  store(p, { fact: 'We use pnpm, not npm', type: 'project', name: 'pnpm' });
  store(p, { fact: 'We deploy on Fridays after the demo', type: 'project', name: 'deploy-day' });
  store(p, { fact: 'The logo is blue', type: 'project', name: 'logo' });
  assert.equal(recall(p, 'which package manager')[0].name, 'pnpm');
  assert.equal(recall(p, 'release schedule')[0].name, 'deploy-day');
  assert.equal(recall(p, 'when do we ship')[0].name, 'deploy-day');
  // An exact word still outranks a synonym.
  store(p, { fact: 'Release notes live in CHANGELOG.md', type: 'project', name: 'release-notes' });
  assert.equal(recall(p, 'release notes')[0].name, 'release-notes');
});
