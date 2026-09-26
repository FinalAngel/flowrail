import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RECIPES, asRedLine } from '../src/core/recipes.js';
import { validateLines } from '../src/core/redlines.js';

const dir = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..', 'examples', 'red-lines');

test('every recipe ships as examples/red-lines/<id>.json and validates', () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  const lines = files.map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
  assert.deepEqual(validateLines(lines), []);
  for (const r of RECIPES) {
    const file = path.join(dir, `${r.id}.json`);
    assert.ok(fs.existsSync(file), `missing ${file}`);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), asRedLine(r), `${r.id}.json is out of date`);
  }
});
