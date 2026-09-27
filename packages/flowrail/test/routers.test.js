import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { routerProblems } from '../src/core/routers.js';
import { tmpdir } from './helpers.js';

const repo = (files) => {
  const root = tmpdir();
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
};

test('no areas, nothing to check', () => {
  assert.equal(routerProblems(repo({ 'CLAUDE.md': '# Rules\n', 'docs/a.md': 'x' })), null);
});

test('a clean router tree passes', () => {
  const root = repo({
    'CLAUDE.md': '| Area | Router |\n|---|---|\n| Sales | [SALES.md](SALES.md) |\n',
    'SALES.md': '# Sales\n- `sales/`: playbooks. See [the pitch](sales/pitch.md).\n',
    'sales/pitch.md': '# Pitch',
  });
  assert.deepEqual(routerProblems(root), []);
});

test('missing router, stale pointer, a page too long and an unreachable folder', () => {
  const root = repo({
    'CLAUDE.md': '| Area | Router |\n|---|---|\n| Sales | [SALES.md](SALES.md) |\n| Ops | [OPS.md](OPS.md) |\n',
    'SALES.md': `# Sales\n- \`sales/old.md\` and [gone](sales/gone.md); \`os.ts\` is prose, \`models/\` too.\n${'word '.repeat(50)}`,
    'sales/pitch.md': '# Pitch',
    'finance/ledger.md': '# Ledger',
  });
  const got = routerProblems(root, { routers: { maxWords: 40 } }).map((p) => `${p.file} ${p.message}`);
  assert.ok(got.includes('OPS.md router is missing'));
  assert.ok(got.some((x) => /^SALES\.md \d+ words/.test(x)));
  assert.ok(got.includes('SALES.md names sales/old.md, which does not exist'));
  assert.ok(got.includes('SALES.md names sales/gone.md, which does not exist'));
  assert.ok(!got.some((x) => /os\.ts|models\//.test(x)), 'bare names and relative mentions are prose');
  assert.ok(got.includes('finance/ reachable from no router (add a line to the area it belongs to)'));
  assert.ok(!got.some((x) => x.startsWith('sales/ ')), 'a folder a router names is reachable');
});

test('roots add the folders under them', () => {
  const root = repo({
    'CLAUDE.md': '| Area | Router |\n|---|---|\n| Co | [CO.md](CO.md) |\n',
    'CO.md': '- `company/finance/`: books (naming the parent would cover every folder under it)\n',
    'company/finance/a.md': 'x',
    'company/legal/b.md': 'x',
  });
  const got = routerProblems(root, { routers: { roots: ['company'] } }).map((p) => p.file);
  assert.deepEqual(got, ['company/legal/']);
});
