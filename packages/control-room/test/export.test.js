import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { boardHtml } from '../src/core/export.js';
import { workspace, BIN } from './helpers.js';

const data = {
  config: { current: { start: '2026-01-05', end: '2026-01-18', label: 'Sprint 3' } },
  tasks: [
    { id: 'T-1', title: 'Ship <script>alert(1)</script>', status: 'In Progress', priority: 'P1', sprint: '2026-01-05', assignee: 'you' },
    { id: 'T-2', title: 'Later', status: 'Todo', priority: 'P2', sprint: '' },
    { id: 'T-3', title: 'Old', status: 'Done', priority: 'P2', sprint: '2025-12-22' },
  ],
};

test('the snapshot is one self-contained, script-free page', () => {
  const html = boardHtml(data, { name: 'Paper Plane' });
  assert.match(html, /Paper Plane: Sprint 3/);
  assert.match(html, /Ship &lt;script&gt;/);
  assert.doesNotMatch(html, /<script/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
  assert.doesNotMatch(html, /Later|Old/, 'only the current sprint by default');
  assert.match(boardHtml(data, { backlog: true }), /Backlog \(1\)[\s\S]*Later/);
});

test('board export writes the file', () => {
  const p = workspace();
  const out = path.join(p.root, 'snap.html');
  execFileSync(process.execPath, [BIN, 'board', 'export', '--out', out], { cwd: p.root });
  assert.match(fs.readFileSync(out, 'utf8'), /<div class="board">/);
  const def = execFileSync(process.execPath, [BIN, 'board', 'export'], { cwd: p.root, encoding: 'utf8' }).trim();
  assert.match(def, /\.flowrail\/exports\/board-\d{4}-\d{2}-\d{2}\.html$/);
});
