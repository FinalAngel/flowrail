import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sprints, rollover, create, update, read, load, trash } from '../src/core/board.js';
import { workspace } from './helpers.js';

const config = { sprintStart: '2026-01-05', sprintLength: 14 };

test('sprints are computed from sprintStart and length', () => {
  const s = sprints(config, new Date(2026, 0, 20));
  assert.equal(s.current.start, '2026-01-19');
  assert.equal(s.current.end, '2026-02-01');
  assert.equal(s.current.label, 'Sprint 2');
  assert.equal(s.next.start, '2026-02-02');
});

test('rollover moves unfinished tasks forward one priority higher', () => {
  const board = {
    tasks: [
      { id: 'T-0001', title: 'old open', status: 'Todo', priority: 'P3', sprint: '2026-01-05', notes: [] },
      { id: 'T-0002', title: 'old done', status: 'Done', priority: 'P3', sprint: '2026-01-05', notes: [] },
      { id: 'T-0003', title: 'backlog', status: 'Todo', priority: 'P3', sprint: '', notes: [] },
      { id: 'T-0004', title: 'already P0', status: 'In Progress', priority: 'P0', sprint: '2026-01-05', notes: [] },
      { id: 'T-0005', title: 'current', status: 'Todo', priority: 'P2', sprint: '2026-01-19', notes: [] },
    ],
  };
  const n = rollover(board, config, new Date(2026, 0, 20));
  assert.equal(n, 2);
  const [a, b, c, d, e] = board.tasks;
  assert.equal(a.sprint, '2026-01-19');
  assert.equal(a.priority, 'P2');
  assert.match(a.notes[0].text, /rolled over from Sprint 1/);
  assert.equal(b.sprint, '2026-01-05');
  assert.equal(c.sprint, '');
  assert.equal(d.priority, 'P0');
  assert.equal(e.notes.length, 0);
  assert.equal(rollover(board, config, new Date(2026, 0, 20)), 0, 'rollover is idempotent');
});

test('create, update, trash through the file', () => {
  const p = workspace({ minimal: true });
  const cfg = { sprintStart: '2026-01-05', sprintLength: 14 };
  const t = create(p, cfg, { title: 'Ship it', sprint: 'backlog', createdBy: 'agent' });
  assert.equal(t.id, 'T-0001');
  assert.equal(t.createdBy, 'agent');
  assert.equal(create(p, cfg, { title: 'Second' }).id, 'T-0002');
  assert.equal(update(p, cfg, 'T-0001', { status: 'in progress' }).status, 'In Progress');
  assert.throws(() => update(p, cfg, 'T-0001', { priority: 'P9' }), /priority/);
  assert.throws(() => create(p, cfg, { title: '  ' }), /title/);
  trash(p, 'T-0002');
  assert.deepEqual(load(p).tasks.map((x) => x.id), ['T-0001']);
  assert.ok(read(p, cfg).config.current.start);
});
