import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSchedule, nextRun, validate, cronLineFor, plistFor } from '../src/core/routines.js';
import { paths } from 'flowrail/api';

test('schedules read as plain words', () => {
  assert.equal(describeSchedule({ every: 'monday', at: '07:00' }), 'Mondays 07:00');
  assert.equal(describeSchedule({ every: 'weekday', at: '08:30' }), 'Weekdays 08:30');
  assert.equal(describeSchedule({ every: 'day', at: '18:00' }), 'Every day 18:00');
  assert.equal(describeSchedule({ every: 'hour', at: '00:15' }), 'Every hour at :15');
});

test('nextRun skips weekends for weekday routines', () => {
  const fri = new Date(2026, 8, 25, 9, 0); // Friday after 08:00
  const next = new Date(nextRun({ every: 'weekday', at: '08:00' }, fri));
  assert.equal(next.getDay(), 1);
  assert.equal(next.getHours(), 8);
  const mon = new Date(nextRun({ every: 'monday', at: '07:00' }, new Date(2026, 8, 21, 6, 0)));
  assert.equal(mon.getDate(), 21);
});

test('validate catches bad routines', () => {
  assert.deepEqual(validate([{ id: 'ok', schedule: { every: 'day', at: '07:00' }, run: { type: 'command', cmd: ['true'] } }]), []);
  assert.equal(validate([{ id: 'x', schedule: { every: 'someday', at: '25:00' }, run: { type: 'shell' } }]).length, 3);
});

test('scheduler entries run flowrail routines run <id> in the workspace', () => {
  const p = paths('/work/proj');
  const r = { id: 'brief', schedule: { every: 'weekday', at: '08:05' } };
  const cron = cronLineFor(p, r);
  assert.match(cron, /^5 8 \* \* 1-5 cd '\/work\/proj' && /);
  assert.match(cron, /'routines' 'run' 'brief'/);
  assert.match(cron, /# flowrail:[0-9a-f]{8}:brief$/);
  const plist = plistFor(p, r);
  assert.equal((plist.match(/<key>Weekday<\/key>/g) || []).length, 5);
  assert.match(plist, /<string>routines<\/string><string>run<\/string><string>brief<\/string>/);
});
