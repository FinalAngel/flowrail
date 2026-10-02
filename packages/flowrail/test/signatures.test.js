// Person signatures on shared comments: one ed25519 key per person, public halves in config "keys".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { planInit, apply } from '../src/core/init.js';
import { signingPublicKey, signAsPerson, personVerified, rulesDrift, acceptRules } from '../src/guard/state.js';
import { tmpdir } from './helpers.js';

const comment = (over = {}) => ({ id: 'c-1', path: 'a.md', quote: 'q', body: 'ship it', created: '2026-10-01T10:00:00Z', email: 'ana@x.ch', status: 'open', ...over });

function project(email = 'ana@x.ch') {
  const root = tmpdir();
  apply(root, planInit(root, { minimal: true }).changes);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.email', email], { cwd: root });
  return root;
}

test('a signature checks out only against the key registered for its email', () => {
  const c = comment();
  c.signature = signAsPerson(c);
  const keys = { 'ana@x.ch': signingPublicKey() };
  assert.equal(personVerified(c, keys), true);
  assert.equal(personVerified({ ...c, body: 'push it' }, keys), false, 'body changed');
  assert.equal(personVerified({ ...c, email: 'bob@x.ch' }, { 'bob@x.ch': keys['ana@x.ch'] }), false, 'email is signed');
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(personVerified(c, { 'ana@x.ch': other }), false, 'someone else\'s key');
  assert.equal(personVerified(c, {}), false, 'no key registered');
  assert.equal(personVerified(c, undefined), false);
});

test('"keys" in config.json is guarded: a key slipped in is drift until accepted', () => {
  const root = project();
  acceptRules(root, 'test');
  const file = path.join(root, 'flowrail', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, shared: true }, null, 2));
  assert.deepEqual(rulesDrift(root), [], 'shared is layout');
  fs.writeFileSync(file, JSON.stringify({ ...cfg, shared: true, keys: { 'eve@x.ch': 'AAAA' } }, null, 2));
  assert.deepEqual(rulesDrift(root), ['flowrail/config.json']);
});

test('SessionStart lists a shared comment signed by a registered person, with the privacy rule', async () => {
  const { sessionStart } = await import('../src/guard/hook.mjs');
  const root = project('ana@x.ch');
  const file = path.join(root, 'flowrail', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...cfg, keys: { 'bob@x.ch': signingPublicKey() } }));
  const c = comment({ email: 'bob@x.ch', author: 'Bob' });
  c.signature = signAsPerson(c);
  const forged = comment({ id: 'c-2', email: 'eve@x.ch', signature: c.signature });
  fs.mkdirSync(path.join(root, 'flowrail', 'comments'), { recursive: true });
  fs.writeFileSync(path.join(root, 'flowrail', 'comments', 'c-1.json'), JSON.stringify(c));
  fs.writeFileSync(path.join(root, 'flowrail', 'comments', 'c-2.json'), JSON.stringify(forged));
  const out = sessionStart(JSON.stringify({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
  assert.match(out, /1 open comment/);
  assert.match(out, /a\.md c-1 \(from Bob\)/);
  assert.match(out, /answered only from files tracked in git/);
  assert.match(out, /1 unverified comment.*a\.md c-2/s);
});
