import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safePath, findRoot, isServable } from '../src/core/paths.js';
import { tmpdir, workspace } from './helpers.js';

test('safePath refuses traversal, absolute paths and odd characters', () => {
  const root = tmpdir();
  for (const bad of ['../etc/passwd', 'a/../../b.md', '/etc/passwd.md', 'C:/x.md', 'a\\b.md', 'a\0.md', '', 'x'.repeat(400) + '.md']) {
    assert.throws(() => safePath(root, bad), { name: 'PathError' }, bad);
  }
});

test('safePath refuses secrets and private folders', () => {
  const root = tmpdir();
  for (const bad of ['.env', 'config/.env.local', 'id_rsa', 'keys/server.pem', 'app-secrets.json', 'aws_credentials.txt', '.npmrc', '.netrc', '.mcp.json', '.git/config', 'node_modules/x/README.md', 'docs/private/plan.md', '.flowrail/trash/x.md']) {
    assert.throws(() => safePath(root, bad), (e) => e.status === 403, bad);
  }
});

test('safePath enforces read and write extensions', () => {
  const root = tmpdir();
  assert.ok(safePath(root, 'docs/readme.md'));
  assert.ok(safePath(root, 'src/app.ts'));
  assert.throws(() => safePath(root, 'bin/tool.exe'), { status: 403 });
  assert.throws(() => safePath(root, 'src/app.js', { write: true }), { status: 403 });
  assert.ok(safePath(root, 'notes/todo.txt', { write: true }));
});

test('safePath refuses a symlink that escapes the root', () => {
  const root = tmpdir();
  const outside = tmpdir();
  fs.writeFileSync(path.join(outside, 'leak.md'), 'secret');
  fs.symlinkSync(outside, path.join(root, 'link'));
  assert.throws(() => safePath(root, 'link/leak.md'), { status: 403 });
});

test('isServable mirrors the gate for listings', () => {
  assert.equal(isServable('docs/a.md'), true);
  assert.equal(isServable('.env'), false);
  assert.equal(isServable('node_modules/a.md'), false);
});

test('findRoot walks up to the workspace', () => {
  const p = workspace({ minimal: true });
  const deep = path.join(p.root, 'a', 'b');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findRoot(deep), p.root);
  assert.equal(findRoot(tmpdir()), null);
});

test('safePath judges a symlink by its target: a link to .env is a secret whatever it is called', () => {
  const root = tmpdir();
  fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
  fs.writeFileSync(path.join(root, 'service-account.json'), '{}');
  fs.symlinkSync('.env', path.join(root, 'envlink.md'));
  fs.symlinkSync('service-account.json', path.join(root, 'notes.md'));
  fs.writeFileSync(path.join(root, 'bin.exe'), 'x');
  fs.symlinkSync('bin.exe', path.join(root, 'exe.md'));
  for (const rel of ['envlink.md', 'notes.md', 'exe.md']) {
    assert.throws(() => safePath(root, rel), { status: 403 }, rel);
    assert.throws(() => safePath(root, rel, { write: true }), { status: 403 }, rel);
  }
  fs.writeFileSync(path.join(root, 'real.md'), 'ok');
  fs.symlinkSync('real.md', path.join(root, 'alias.md'));
  assert.ok(safePath(root, 'alias.md'));
});

test('the secret denylist covers service accounts, kubeconfigs and *.env files', () => {
  const root = tmpdir();
  for (const bad of ['service-account.json', 'gcp/service-account-prod.json', 'kubeconfig.yaml', 'secrets.env', '.envrc', '.ENV', 'x.pfx']) {
    assert.throws(() => safePath(root, bad), (e) => e.status === 403, bad);
  }
});
