import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from '../src/core/workflows.js';

test('parses steps and detects gates', () => {
  const wf = parseWorkflow(`# Release\n\nHow we ship.\n\n## Step 1: Investigate the failure\nlook\n\n## Step 2: GATE: agree on priority\nask\n\n## Step 3 - SIGN-OFF before publish\nwait\n\n## Step 4: Publish\ndone\n`, 'flowrail/workflows/release.md');
  assert.equal(wf.title, 'Release');
  assert.equal(wf.description, 'How we ship.');
  assert.deepEqual(wf.steps.map((s) => [s.n, s.gate]), [[1, false], [2, true], [3, true], [4, false]]);
  assert.equal(wf.steps[0].title, 'Investigate the failure');
  assert.equal(wf.steps[0].body, 'look');
});

test('falls back to the file name for a title', () => {
  const wf = parseWorkflow('## Step 1: Only step\n', 'flowrail/workflows/ship-a-change.md');
  assert.equal(wf.title, 'ship a change');
  assert.equal(wf.steps.length, 1);
});
