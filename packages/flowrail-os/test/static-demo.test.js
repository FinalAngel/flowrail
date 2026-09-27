import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { snapshot, snapshotFile } from '../ui/lib/snapshot.js';

test('snapshotFile keys the answer by path and by the one parameter that changes it', () => {
  assert.equal(snapshotFile('/overview'), 'overview');
  assert.equal(snapshotFile('/audit?days=90'), 'audit');
  assert.equal(snapshotFile('/docs/file?path=docs/a b.md'), 'docs/file/docs~2Fa~20b.md');
  assert.equal(snapshotFile('/comments'), 'comments');
  assert.equal(snapshotFile('/runs/2026-x'), 'runs/2026-x');
});

test('the built demo answers what the pages ask, searches in the browser and refuses writes', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flowrail-site-'));
  try {
    execFileSync(process.execPath, [path.join(import.meta.dirname, '..', 'scripts', 'static-demo.js'), out]);
    assert.match(fs.readFileSync(path.join(out, 'index.html'), 'utf8'), /name="flowrail-static"/);
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const f = path.join(out, url);
      return fs.existsSync(f) ? new Response(fs.readFileSync(f)) : new Response('', { status: 404 });
    };
    try {
      assert.ok((await snapshot('/board')).tasks.length > 0);
      const tree = await snapshot('/docs/tree');
      assert.ok(Array.isArray(tree) && tree.length);
      assert.match((await snapshot('/docs/file?path=README.md')).text, /\w/);
      const hits = await snapshot('/search?q=sync');
      assert.ok(hits.length > 0 && hits.every((h) => !('text' in h)));
      assert.deepEqual(await snapshot('/search?q='), []);
      await assert.rejects(snapshot('/board', { _action: 'create', title: 'x' }), /read-only demo/);
      await assert.rejects(snapshot('/docs/file?path=nope.md'), /Not in this demo/);
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
