// The activity journal: one JSON line per thing that happened (a task moved, a comment added or
// resolved, an agent started, a routine ran, a review scored). Each line says who: `who` is the
// person at the keyboard (identity.me), `by` is 'human' or 'agent', and an agent's line carries the
// Claude Code session it ran in, so `claude --resume <session>` reopens the work on that machine.
// Shared ("shared": true): flowrail/activity/YYYY-MM.jsonl, committed and merged line by line
// (`flowrail/activity/*.jsonl merge=union` in .gitattributes). Otherwise .flowrail/activity.log.
import fs from 'node:fs';
import path from 'node:path';
import { appendLine, readJsonl, nowIso } from 'flowrail/api';
import { me, shared } from './identity.js';

const month = (iso) => String(iso).slice(0, 7);

/** The file a line written at `at` goes to. */
export function fileFor(p, at = nowIso()) {
  return shared(p) ? path.join(p.root, 'flowrail', 'activity', `${month(at)}.jsonl`) : p.activityLog;
}

/**
 * Append one line: { at, kind, by, who, session?, ...entry }. Never throws: the journal is a record,
 * not a gate, and a write that fails must not undo the work it describes.
 */
export function record(p, entry, env = process.env) {
  const by = entry.by === 'agent' ? 'agent' : 'human';
  const session = by === 'agent' ? entry.session || env.CLAUDE_CODE_SESSION_ID : undefined;
  const line = { at: nowIso(), ...entry, by, who: entry.who || me(p).email || me(p).name, ...(session ? { session: String(session) } : {}) };
  try { appendLine(fileFor(p, line.at), line); } catch { /* best effort */ }
  return line;
}

/** Every line since `since` (Date or ISO), oldest first: the local log plus the shared months. */
export function entries(p, since = null) {
  const from = since ? new Date(since).toISOString() : '';
  const dir = path.join(p.root, 'flowrail', 'activity');
  let months = [];
  try { months = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}\.jsonl$/.test(n) && (!from || n.slice(0, 7) >= month(from))); } catch { /* none yet */ }
  const out = [...readJsonl(p.activityLog), ...months.sort().flatMap((n) => readJsonl(path.join(dir, n)))];
  return out.filter((e) => e && typeof e.at === 'string' && (!from || e.at >= from)).sort((a, b) => a.at.localeCompare(b.at));
}
