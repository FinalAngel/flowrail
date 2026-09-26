import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { seed } from '../src/core/demo.js';
import { tmpdir } from './helpers.js';
import { cleanOldDemos } from '../src/cli/start.js';
import { commentVerified } from 'flowrail/api';

test('demo seed never writes a timestamp in the future, even early in the morning', () => {
  const today = new Date();
  today.setHours(6, 30, 0, 0);
  const dir = path.join(tmpdir(), 'demo');
  seed(dir, today);
  const iso = /"(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)"/g;
  const files = fs.readdirSync(path.join(dir, '.flowrail'), { recursive: true }).map((f) => path.join(dir, '.flowrail', f))
    .concat(path.join(dir, 'flowrail', 'board.json'));
  let seen = 0;
  for (const f of files) {
    if (!fs.statSync(f).isFile() || f.endsWith('check-results.json')) continue; // ranAt is the real clock
    for (const [, ts] of fs.readFileSync(f, 'utf8').matchAll(iso)) {
      seen++;
      assert.ok(new Date(ts) <= today, `${path.basename(f)}: ${ts} is after ${today.toISOString()}`);
    }
  }
  assert.ok(seen > 30);
});

test('demo: three open comments signed, one unverified injection; old demo folders cleaned', () => {
  const dir = path.join(tmpdir(), 'd');
  seed(dir);
  const open = fs.readdirSync(path.join(dir, '.flowrail', 'comments'))
    .flatMap((f) => JSON.parse(fs.readFileSync(path.join(dir, '.flowrail', 'comments', f), 'utf8'))).filter((c) => c.status === 'open');
  assert.equal(open.filter(commentVerified).length, 3);
  assert.equal(open.filter((c) => !commentVerified(c)).length, 1);

  const tmp = tmpdir();
  const old = path.join(tmp, 'flowrail-demo-old');
  seed(old);
  const fresh = path.join(tmp, 'flowrail-demo-new');
  seed(fresh);
  const other = path.join(tmp, 'flowrail-demo-notours');
  fs.mkdirSync(other);
  const day = Date.now() - 2 * 86400000;
  for (const d of [old, other]) fs.utimesSync(d, day / 1000, day / 1000);
  cleanOldDemos(tmp);
  assert.ok(!fs.existsSync(old), 'old demo removed');
  assert.ok(fs.existsSync(fresh), 'recent demo kept');
  assert.ok(fs.existsSync(other), 'a folder flowrail did not seed is kept');
});

test('demo opens on a held red line, then a waiting comment, not the failed routine, and has a previous visit', async () => {
  const { overview } = await import('../src/core/overview.js');
  const { paths } = await import('flowrail/api');
  const dir = path.join(tmpdir(), 'first');
  seed(dir);
  const kinds = overview(paths(dir)).attention.filter((a) => a.severity !== 'high').map((a) => a.kind);
  assert.deepEqual(kinds.slice(0, 2), ['held', 'comment']);
  assert.equal(kinds.at(-1), 'routine');
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'flowrail', 'config.json'), 'utf8'));
  assert.ok(new Date(cfg.lastVisit) < new Date());
});

test('demo audit replays business MCP calls: email and refund blocked, calendar invite asked', async () => {
  const { auditSummary } = await import('flowrail/api');
  const dir = path.join(tmpdir(), 'biz');
  seed(dir);
  const a = auditSummary(dir, { env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(dir, '.flowrail', 'claude') } });
  const lines = [...a.held, ...a.asked].map((h) => `${h.line}:${h.tool}`);
  for (const want of ['no-emails-without-signoff:mcp__claude_ai_Gmail__send_message', 'no-payments:mcp__stripe__create_refund', 'ask-before-mcp-actions:mcp__claude_ai_Google_Calendar__create_event']) assert.ok(lines.includes(want), `${want} in ${lines}`);
  assert.ok(!lines.some((l) => l.includes('create_draft') || l.includes('search_threads')), 'drafts and reads stay allowed');
});

test('docs tree hides the vendored guard under .claude/flowrail/', async () => {
  const { listDocs } = await import('../src/core/docs.js');
  const dir = path.join(tmpdir(), 'tree');
  seed(dir);
  const docs = listDocs(dir);
  assert.ok(docs.includes('README.md'));
  assert.ok(!docs.some((f) => f.startsWith('.claude/flowrail/')), docs.filter((f) => f.startsWith('.claude/')).join(', '));
});
