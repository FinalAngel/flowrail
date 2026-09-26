import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, run } from './corpus.js';
import { BUILTIN_IDS } from '../src/guard/builtins.js';

const corpus = load();

test('every builtin has a corpus file', () => {
  assert.deepEqual(Object.keys(corpus).sort(), [...BUILTIN_IDS].sort());
});

for (const [builtin, probes] of Object.entries(corpus)) {
  test(`corpus: ${builtin} (${probes.length} probes)`, () => {
    // GAP lines are documented misses: if one starts to hold, move it to HOLD and fix the docs.
    const wrong = probes.filter((p) => (run(builtin, p.call, p.params, p.env).decision !== 'allow') !== (p.expect === 'HOLD'));
    assert.deepEqual(wrong.map((p) => `line ${p.line}: ${p.expect} ${p.call.replace(/\n/g, '\\n')}`), []);
  });
}
