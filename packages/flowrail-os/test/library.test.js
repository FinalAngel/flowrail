import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { areasFromTable, areas, areaOf, mentions, staleness, library, context, normalizeLinks, titleOf } from '../src/core/library.js';
import { saveConfig, loadConfig, paths } from 'flowrail/api';
import { tmpdir } from './helpers.js';

const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };

test('a CLAUDE.md table that links routers gives the areas', () => {
  const md = '| Department | Router | Owns |\n| --- | --- | --- |\n| Sales | [SALES.md](SALES.md) | leads |\n| **Product** | [router](docs/PRODUCT.md) | roadmap |\n| Notes | plain text | none |\n';
  assert.deepEqual(areasFromTable(md), [{ name: 'Sales', router: 'SALES.md' }, { name: 'Product', router: 'docs/PRODUCT.md' }]);
});

test('a document belongs to the area that names it, else the longest folder above it', () => {
  const root = tmpdir();
  write(root, 'SALES.md', '# Sales\n- `playbooks/` all of them\n- [pricing](docs/pricing.md)\n');
  write(root, 'ENG.md', '# Eng\n- `playbooks/release/` release only\n- docs/ everything else\n');
  for (const f of ['playbooks/cold.md', 'playbooks/release/tag.md', 'docs/pricing.md', 'docs/arch.md', 'misc.md']) write(root, f, '# x');
  const list = areas(root, { areas: [{ name: 'Sales', router: 'SALES.md' }, { name: 'Eng', router: 'ENG.md' }, { name: 'Gone', router: 'NOPE.md' }] });
  assert.deepEqual(list.map((a) => a.name), ['Sales', 'Eng'], 'a missing router is skipped');
  assert.equal(areaOf('playbooks/cold.md', list), 'Sales');
  assert.equal(areaOf('playbooks/release/tag.md', list), 'Eng', 'longest folder wins');
  assert.equal(areaOf('docs/pricing.md', list), 'Sales', 'an exact mention beats a folder');
  assert.equal(areaOf('docs/arch.md', list), 'Eng');
  assert.equal(areaOf('SALES.md', list), 'Sales', 'a router is in its own area');
  assert.equal(areaOf('misc.md', list), null);
  assert.ok(mentions('see [x](../a.md) and https://e.com/b/c', 'docs/r.md').has('a.md'));
  assert.ok(!mentions('https://e.com/b/c and `*.md`', 'r.md').has('e.com/b/c'));
});

test('staleness follows the thresholds', () => {
  assert.equal(staleness(0), 'fresh');
  assert.equal(staleness(29), 'fresh');
  assert.equal(staleness(30), 'aging');
  assert.equal(staleness(90), 'stale');
  assert.equal(staleness(10, [5, 8]), 'stale');
  assert.equal(staleness(null), 'unknown');
  assert.equal(titleOf('---\ntitle: From frontmatter\n---\n# Heading', 'a.md'), 'From frontmatter');
  assert.equal(titleOf('# Heading\ntext', 'a.md'), 'Heading');
  assert.equal(titleOf('text', 'dir/some-file.md'), 'some file');
});

test('the library dates committed docs by git and changed ones by their file time', () => {
  const root = tmpdir();
  write(root, 'old.md', '# Old');
  write(root, 'new.md', '# New');
  const g = (args, date) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root, stdio: 'ignore', env: { ...process.env, ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } });
  g(['init', '-q']);
  g(['add', 'old.md']);
  g(['commit', '-q', '-m', 'old'], new Date(Date.now() - 120 * 86400000).toISOString());
  g(['add', 'new.md']);
  g(['commit', '-q', '-m', 'new']);
  write(root, 'draft.md', '# Draft');
  const r = library(root, { staleDays: [30, 90] });
  const by = Object.fromEntries(r.docs.map((d) => [d.path, d]));
  assert.equal(r.source, 'git');
  assert.equal(by['old.md'].state, 'stale', 'the commit date counts, not the fresh checkout mtime');
  assert.equal(by['new.md'].state, 'fresh');
  assert.equal(by['draft.md'].uncommitted, true);
  assert.deepEqual(r.counts, { fresh: 2, aging: 0, stale: 1, unknown: 0 });
  fs.writeFileSync(path.join(root, '.env'), 'X=1');
  assert.ok(!library(root, {}).docs.some((d) => d.path.includes('.env')));
});

test('context lists one entry per folder with an index.md, inside the repo only', () => {
  const root = tmpdir();
  write(root, 'flowrail/context/book/index.md', '---\ntitle: A book\nsource: https://example.com/b\nsummary: Short\n---\n# A book');
  write(root, 'flowrail/context/book/ch1.md', '# One');
  write(root, 'flowrail/context/no-index/notes.md', '# x');
  const c = context(root, {});
  assert.deepEqual(c.entries.map((e) => [e.slug, e.title, e.source, e.summary, e.docs]), [['book', 'A book', 'https://example.com/b', 'Short', ['flowrail/context/book/ch1.md']]]);
  assert.equal(context(root, { contextDir: '../elsewhere' }).entries.length, 0);
  assert.match(context(root, { contextDir: '../elsewhere' }).error, /outside/);
});

test('links: web links open outside, repo paths in Docs, anything else is dropped', () => {
  const out = normalizeLinks([
    { category: 'A', items: [
      { title: 'Web', url: 'https://example.com/x', icon: 'board' },
      { title: 'Doc', url: 'docs/a.md', description: 'd' },
      { title: 'Bad', url: 'javascript:alert(1)' },
      { title: 'Data', url: 'data:text/html,x' },
      { title: 'Up', url: '../secret.md' },
      { title: 'Svg', url: 'https://example.com', icon: '<svg onload=x>' },
      { url: 'https://example.com/untitled' },
    ] },
    { category: 'B', links: [{ title: 'Alt key', url: 'http://example.com' }] },
    { category: 'Empty', items: [{ title: 'x', url: 'file:///etc/passwd' }] },
    'junk',
  ]);
  assert.deepEqual(out.map((c) => c.category), ['A', 'B']);
  assert.deepEqual(out[0].items.map((l) => [l.title, l.external, l.href]), [
    ['Web', true, 'https://example.com/x'], ['Doc', false, '#/docs?path=docs%2Fa.md'], ['Svg', true, 'https://example.com/'],
  ]);
  assert.equal(out[0].items[0].icon, 'board');
  assert.equal(out[0].items[2].icon, undefined, 'only icon names, never markup');
});

test('areas, nav, staleDays and contextDir are file-only settings', () => {
  const root = tmpdir();
  const p = paths(root);
  fs.mkdirSync(p.state, { recursive: true });
  saveConfig(p, { name: 'x', nav: { Sales: ['board'] }, areas: [{ name: 'A', router: 'A.md' }], contextDir: '..' });
  const c = loadConfig(p);
  assert.equal(c.nav, undefined);
  assert.equal(c.areas, undefined);
  assert.equal(c.contextDir, undefined);
});

test('the demo serves the library, context and links behind the token', async () => {
  const { seed } = await import('../src/core/demo.js');
  const { startServer } = await import('../src/server.js');
  const root = tmpdir();
  seed(root);
  const s = await startServer({ root, port: 0 });
  try {
    const get = async (u, token = s.token) => {
      const r = await fetch(`${s.url}/api/${u}`, { headers: token ? { 'X-Flowrail-Token': token } : {} });
      return { status: r.status, json: await r.json() };
    };
    const lib = await get('library');
    assert.equal(lib.status, 200);
    assert.deepEqual(lib.json.areas.map((a) => a.name), ['Product', 'Engineering']);
    assert.ok(lib.json.counts.stale >= 1 && lib.json.counts.aging >= 1 && lib.json.counts.fresh >= 1, JSON.stringify(lib.json.counts));
    assert.equal((await get('context')).json.entries.length, 2);
    const links = (await get('links')).json;
    assert.ok(links.every((c) => c.items.every((l) => l.href.startsWith('#/docs?path=') || l.href.startsWith('https://'))));
    assert.equal((await get('library', null)).status, 401);
  } finally { await s.close(); }
});
