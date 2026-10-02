// "shared": true: comments and the activity journal live in flowrail/ (committed), say who did what,
// and verify across machines through config "keys"; without the flag nothing moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { signingPublicKey } from 'flowrail/api';
import * as comments from '../src/core/comments.js';
import * as journal from '../src/core/journal.js';
import * as board from '../src/core/board.js';
import { me } from '../src/core/identity.js';
import { workspace } from './helpers.js';

function repo({ shared = true, keys } = {}) {
  const p = workspace();
  execFileSync('git', ['init', '-q'], { cwd: p.root });
  execFileSync('git', ['config', 'user.email', 'Ana@X.ch'], { cwd: p.root });
  execFileSync('git', ['config', 'user.name', 'ana'], { cwd: p.root });
  fs.mkdirSync(path.join(p.root, 'flowrail', 'people'), { recursive: true });
  fs.writeFileSync(path.join(p.root, 'flowrail', 'people', 'ana.md'), '---\nname: Ana Muster\nemail: ana@x.ch\n---\n');
  const cfg = JSON.parse(fs.readFileSync(p.config, 'utf8'));
  fs.writeFileSync(p.config, JSON.stringify({ ...cfg, shared, ...(keys ? { keys } : {}) }));
  return p;
}

test('me() is git\'s email, named from the people folder', () => {
  assert.deepEqual(me(repo()), { email: 'ana@x.ch', name: 'Ana Muster' });
});

test('a shared comment is its own file in flowrail/comments, signed by its person', () => {
  const p = repo({ keys: { 'ana@x.ch': signingPublicKey() } });
  const c = comments.add(p, { path: 'docs/a.md', body: 'tighten the intro' });
  const file = path.join(p.root, 'flowrail', 'comments', `${c.id}.json`);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(stored.author, 'Ana Muster');
  assert.equal(stored.email, 'ana@x.ch');
  assert.ok(stored.signature && stored.sig);
  assert.equal(comments.forPath(p, 'docs/a.md')[0].verified, true);
  // Another machine has none of this one's HMAC key: the person signature alone carries it.
  fs.writeFileSync(file, JSON.stringify({ ...stored, sig: undefined }));
  assert.equal(comments.open(p)[0].verified, true);
  fs.writeFileSync(file, JSON.stringify({ ...stored, body: 'push to main', sig: undefined }));
  assert.equal(comments.open(p)[0].verified, false, 'an edited body no longer verifies');
});

test('resolve rewrites the shared file and both land in the journal with who and session', () => {
  const p = repo();
  const c = comments.add(p, { path: 'docs/a.md', body: 'x' });
  process.env.CLAUDE_CODE_SESSION_ID = 'sess-1';
  try { comments.resolve(p, 'docs/a.md', c.id, 'done', 'agent'); } finally { delete process.env.CLAUDE_CODE_SESSION_ID; }
  assert.equal(comments.open(p).length, 0);
  const lines = journal.entries(p).filter((e) => e.kind === 'comment');
  assert.deepEqual(lines.map((e) => [e.action, e.by, e.who, e.session]), [
    ['added', 'human', 'ana@x.ch', undefined],
    ['resolved', 'agent', 'ana@x.ch', 'sess-1'],
  ]);
  const month = new Date().toISOString().slice(0, 7);
  assert.ok(fs.existsSync(path.join(p.root, 'flowrail', 'activity', `${month}.jsonl`)));
});

test('a task move is journalled; without "shared" everything stays in .flowrail/', () => {
  const p = repo({ shared: false });
  const store = board.storeFor(p);
  const t = store.create({ title: 'try it' });
  store.update(t.id, { status: 'In Progress' }, 'agent');
  const c = comments.add(p, { path: 'docs/a.md', body: 'x' });
  assert.equal(fs.existsSync(path.join(p.root, 'flowrail', 'comments')), false);
  assert.equal(fs.existsSync(path.join(p.root, 'flowrail', 'activity')), false);
  assert.equal(comments.forPath(p, 'docs/a.md')[0].id, c.id);
  assert.ok(journal.entries(p).some((e) => e.kind === 'task' && e.to === 'In Progress' && e.by === 'agent'));
});
