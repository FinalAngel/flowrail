#!/usr/bin/env node
// Count the probe corpus and check it: "N bypass probes held, M false-positive probes allowed".
// Usage: node scripts/corpus-stats.js [--json]
import { load, run } from '../test/corpus.js';

const corpus = load();
const rows = Object.entries(corpus).map(([builtin, probes]) => {
  const hold = probes.filter((p) => p.expect === 'HOLD');
  const allow = probes.filter((p) => p.expect === 'ALLOW');
  return {
    builtin,
    hold: hold.length,
    held: hold.filter((p) => run(builtin, p.call, p.params, p.env).decision !== 'allow').length,
    allow: allow.length,
    allowed: allow.filter((p) => run(builtin, p.call, p.params, p.env).decision === 'allow').length,
    gaps: probes.filter((p) => p.expect === 'GAP').length,
  };
});
const sum = (k) => rows.reduce((n, r) => n + r[k], 0);
const total = { held: sum('held'), hold: sum('hold'), allowed: sum('allowed'), allow: sum('allow'), gaps: sum('gaps') };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ rows, total }, null, 2));
} else {
  for (const r of rows) console.log(`${r.builtin.padEnd(16)} ${r.held}/${r.hold} held   ${r.allowed}/${r.allow} allowed   ${r.gaps} known gaps`);
  console.log(`\n${total.held} bypass probes held, ${total.allowed} false-positive probes allowed, ${total.gaps} known gaps documented.`);
}
if (total.held !== total.hold || total.allowed !== total.allow) process.exitCode = 1;
