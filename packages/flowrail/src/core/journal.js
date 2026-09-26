// Compare the machine-local journal (outside the repo, hash-chained; written by the guard in
// src/guard/state.js) with .flowrail/redlines.log, so an edited or trimmed log shows up.
import { readJsonl } from './util.js';
import { appendJournal, readJournal, verifyChain, journalPath } from '../guard/state.js';

export { appendJournal };

/** Stable JSON: sorted keys, so key order never makes two equal entries look different. */
const canon = (v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
  : Array.isArray(v) ? `[${v.map(canon).join(',')}]` : JSON.stringify(v));

/**
 * Edited means: the journal's chain is broken, a journalled entry is missing from the log (or was
 * changed there), or the log holds an entry from the journal's lifetime that the journal never
 * recorded. Log lines older than the journal's first entry predate it and are only counted.
 * @returns {{ok:boolean, entries:number, older:number, problems:string[], file:string}}
 */
export function verifyJournal(p) {
  const journal = readJournal(p.root) || [];
  const problems = [];
  const chain = verifyChain(journal);
  if (!chain.ok) problems.push(`the journal's hash chain breaks at entry ${chain.brokenAt + 1}`);
  const want = new Map();
  // Accepted snapshots of the rules live only in the journal (flowrail writes them, not the log).
  for (const { prev, hash, ...entry } of journal) {
    if (entry.decision === 'accepted' || entry.decision === 'epoch') continue;
    const k = canon(entry);
    want.set(k, (want.get(k) || 0) + 1);
  }
  const logged = journal.filter((e) => e.decision !== 'accepted' && e.decision !== 'epoch');
  const start = logged.length ? String(logged[0].at || '') : null;
  let older = 0;
  let extra = 0;
  for (const e of readJsonl(p.redlinesLog)) {
    const k = canon(e);
    if (want.get(k)) { want.set(k, want.get(k) - 1); continue; }
    if (start === null || String(e.at || '') < start) older++;
    else extra++;
  }
  const missing = [...want.values()].reduce((s, n) => s + n, 0);
  if (missing) problems.push(`${missing} journalled entr${missing === 1 ? 'y is' : 'ies are'} missing from or changed in .flowrail/redlines.log`);
  if (extra) problems.push(`.flowrail/redlines.log has ${extra} entr${extra === 1 ? 'y' : 'ies'} the journal never recorded`);
  return { ok: problems.length === 0, entries: logged.length, older, problems, file: journalPath(p.root) };
}
