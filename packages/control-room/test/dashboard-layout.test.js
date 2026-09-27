import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readLayout } from '../ui/pages/dashboard.js';

test('a saved dashboard layout is repaired: every card once, unknown ids dropped', () => {
  assert.deepEqual(readLayout(null).cols, [['needs', 'today', 'recent'], ['setup', 'rails', 'sprint']]);
  const l = readLayout({ cols: [['sprint', 'x', 'sprint'], ['needs']], hidden: ['rails', 'zz'] });
  assert.deepEqual(l.cols, [['sprint', 'today', 'recent'], ['needs', 'setup', 'rails']]);
  assert.deepEqual(l.hidden, ['rails']);
  assert.deepEqual(readLayout({ cols: 'nope' }).cols, readLayout(null).cols);
});
