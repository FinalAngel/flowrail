import { test } from 'node:test';
import assert from 'node:assert/strict';
import { svgShapes } from '../src/core/svg.js';

test('keeps stroke shapes and their geometry', () => {
  assert.deepEqual(svgShapes("<circle cx='12' cy='12' r='9'/><path d='M3 12h18'/>"), [
    { tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } }, { tag: 'path', attrs: { d: 'M3 12h18' } }]);
  assert.deepEqual(svgShapes('<polyline points="1,2 3,4"/>'), [{ tag: 'polyline', attrs: { points: '1,2 3,4' } }]);
});

test('drops everything that could run or fetch', () => {
  for (const bad of [
    '<script>alert(1)</script>',
    '<foreignObject><div>x</div></foreignObject>',
    '<image href="https://x/y.png"/>',
    '<use href="#a"/>',
    '<a href="javascript:alert(1)"><path d="M1 1"/></a>',
  ]) assert.ok(svgShapes(bad).every((s) => s.tag === 'path'), bad);
  assert.deepEqual(svgShapes('<path d="M1 1" onload="alert(1)" style="x" href="javascript:alert(1)"/>'), [{ tag: 'path', attrs: { d: 'M1 1' } }]);
  assert.deepEqual(svgShapes('<path d="url(javascript:x)"/>'), []);
  assert.deepEqual(svgShapes('<circle r="&#106;avascript"/>'), [], 'entities are refused outright');
  assert.deepEqual(svgShapes('<rect width="calc(1px)" x="1"/>'), [{ tag: 'rect', attrs: { x: '1' } }]);
  assert.deepEqual(svgShapes(123), []);
  assert.deepEqual(svgShapes('x'.repeat(5000)), []);
});

test('links and artifact sidecars carry sanitized shapes', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { normalizeLinks } = await import('../src/core/library.js');
  const artifacts = await import('../src/core/artifacts.js');
  const { workspace } = await import('./helpers.js');
  const [cat] = normalizeLinks([{ category: 'Web', links: [{ title: 'Site', url: 'https://example.com', svg: '<circle cx="12" cy="12" r="9" onclick="x()"/><script>x()</script>' }] }]);
  assert.deepEqual(cat.items[0].shapes, [{ tag: 'circle', attrs: { cx: '12', cy: '12', r: '9' } }]);
  const p = workspace();
  fs.mkdirSync(p.artifacts, { recursive: true });
  fs.writeFileSync(path.join(p.artifacts, 'weekly.html'), '<title>W</title>');
  fs.writeFileSync(path.join(p.artifacts, 'weekly.json'), JSON.stringify({ kind: 'report', category: 'ops', svg: '<rect x="4" y="4" width="16" height="16"/>' }));
  const a = artifacts.list(p).find((x) => x.name === 'weekly.html');
  assert.equal(a.kind, 'report');
  assert.equal(a.category, 'ops');
  assert.equal(a.shapes[0].tag, 'rect');
});
