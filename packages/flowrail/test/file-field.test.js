import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { decide, validateLines } from '../src/core/redlines.js';
import { tmpdir } from './helpers.js';

const root = tmpdir();
fs.mkdirSync(path.join(root, 'leads'));
fs.mkdirSync(path.join(root, 'scripts'));
fs.writeFileSync(path.join(root, 'scripts', 'send.ts'), '');
const lead = (name, fm) => fs.writeFileSync(path.join(root, 'leads', name), `---\n${fm}\n---\nNotes`);
lead('ch.md', 'company: A\nregion: Switzerland\nstatus: new');
lead('de.md', 'company: B\nregion: Germany\nstatus: qualified');
lead('at.md', 'region: "Österreich"\nstatus: new');
lead('de-replied.md', 'region: Germany\nstatus: responded');
fs.writeFileSync(path.join(root, '.env'), 'region: Germany');
fs.symlinkSync(path.join(root, 'leads', 'de.md'), path.join(root, 'leads', 'link.md'));

const lines = [{
  id: 'no-cold-de-at', title: 'No cold outreach to Germany or Austria', severity: 'block',
  hook: { tool: 'Bash', builtin: 'file-field', params: {
    scripts: ['scripts/send.ts'], commands: [['npm', 'run', 'send']], flag: '--lead', field: 'region',
    values: ['germany', 'deutsch', 'austria', 'österreich'], except: { status: ['responded', 'call-done'] },
  } },
}];
const run = (command, cwd = root) => decide(lines, 'Bash', { command }, { root, cwd }).decision;

test('the line is valid, and a malformed one is not', () => {
  assert.deepEqual(validateLines(lines), []);
  assert.equal(decide([{ ...lines[0], hook: { tool: 'Bash', builtin: 'file-field', params: { flag: '--lead' } } }], 'Bash', { command: 'ls' }, { root }).decision, 'ask');
});

test('holds a send whose lead file carries a blocked value', () => {
  for (const cmd of [
    'npx tsx scripts/send.ts --to x@b.de --lead leads/de.md',
    'tsx ./scripts/send.ts --lead=leads/de.md',
    `node ${root}/scripts/send.ts --lead ${root}/leads/at.md`,
    'npx tsx scripts/send.ts --lead leads/ch.md --lead leads/de.md',
    'npm run send -- --lead leads/de.md',
    'cd leads && npx tsx ../scripts/send.ts --lead de.md',
    'npx tsx scripts/send.ts --lead leads/link.md',
  ]) assert.equal(run(cmd), 'deny', cmd);
});

test('lets a send through when the file allows it', () => {
  for (const cmd of [
    'npx tsx scripts/send.ts --lead leads/ch.md',
    'npx tsx scripts/send.ts --lead leads/de-replied.md',
    'cat leads/de.md', 'npx tsx scripts/other.ts --lead leads/de.md',
  ]) assert.equal(run(cmd), 'allow', cmd);
});

test('asks when it cannot tell', () => {
  for (const cmd of [
    'npx tsx scripts/send.ts --to x@y.ch', 'npx tsx scripts/send.ts --lead',
    'npx tsx scripts/send.ts --lead $LEAD', 'npx tsx scripts/send.ts --lead leads/missing.md',
    'npx tsx scripts/send.ts --lead .env', 'npx tsx scripts/send.ts --lead /etc/hosts',
  ]) assert.equal(run(cmd), 'ask', cmd);
});

test('verify brings its own records for a file-field line', async () => {
  const { verifyRedlines } = await import('../src/core/verify.js');
  const v = verifyRedlines(null, { lines, noFloor: true });
  assert.equal(v.ok, true, JSON.stringify(v.lines));
  assert.equal(v.lines[0].positive.length, 3);
  assert.deepEqual(v.lines[0].negative.map((x) => x.ok), [true, true]);
});
