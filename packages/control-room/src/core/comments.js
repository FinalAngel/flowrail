// Comments on documents. Stored per machine in .flowrail/comments/<encoded-path>.json.
// A comment is an instruction for the agent; the agent resolves it after acting.
// Comments added through the dashboard are HMAC-signed with a machine-local key kept outside the
// repo, so a comment the agent wrote into .flowrail/comments/ by hand shows as unverified.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, nowIso, randomId, listFiles, trashJson } from 'flowrail/api';
import { signComment, commentVerified } from 'flowrail/api';

const fileFor = (p, rel) => path.join(p.comments, encodeURIComponent(rel) + '.json');

function load(p, rel) {
  const list = readJson(fileFor(p, rel), []);
  return Array.isArray(list) ? list : [];
}

const safeVerified = (c) => { try { return !!commentVerified(c); } catch { return false; } };
/** The stored comment plus `verified`: its signature checks out against this machine's key. */
const withTrust = (c) => ({ ...c, verified: safeVerified(c) });

export const forPath = (p, rel) => load(p, rel).map(withTrust);

export function all(p) {
  const out = [];
  for (const name of listFiles(p.comments, '.json')) {
    const list = readJson(path.join(p.comments, name), []);
    if (Array.isArray(list)) out.push(...list);
  }
  return out.map(withTrust).sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export const open = (p) => all(p).filter((c) => c.status === 'open');

function save(p, rel, list) {
  if (list.length) writeJson(fileFor(p, rel), list);
  else fs.rmSync(fileFor(p, rel), { force: true });
}

export function add(p, { path: rel, quote = '', body, author = 'you', anchor, createdBy = 'human' }) {
  if (!rel || typeof rel !== 'string') throw Object.assign(new Error('path is required'), { status: 400 });
  if (!body || !String(body).trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
  const list = load(p, rel);
  const c = {
    id: `c-${randomId(3)}`,
    path: rel,
    quote: String(quote).slice(0, 2000),
    ...(anchor && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) ? { anchor: { start: anchor.start, end: anchor.end } } : {}),
    body: String(body).slice(0, 10000),
    author: String(author).slice(0, 80),
    createdBy,
    created: nowIso(),
    status: 'open',
  };
  if (createdBy === 'human') c.sig = signComment(c);
  list.push(c);
  save(p, rel, list);
  return withTrust(c);
}

function mutate(p, rel, id, fn) {
  const list = load(p, rel);
  const i = list.findIndex((c) => c.id === id);
  if (i === -1) throw Object.assign(new Error(`no comment ${id} on ${rel}`), { status: 404 });
  const result = fn(list, i);
  save(p, rel, list);
  return result;
}

export function resolve(p, rel, id, note, by = 'agent') {
  return mutate(p, rel, id, (list, i) => {
    Object.assign(list[i], { status: 'resolved', resolvedAt: nowIso(), resolvedBy: by });
    if (note) list[i].resolveNote = String(note).slice(0, 4000);
    return withTrust(list[i]);
  });
}

export function reopen(p, rel, id) {
  return mutate(p, rel, id, (list, i) => {
    list[i].status = 'open';
    delete list[i].resolvedAt;
    delete list[i].resolveNote;
    delete list[i].resolvedBy;
    return withTrust(list[i]);
  });
}

export function remove(p, rel, id) {
  const removed = mutate(p, rel, id, (list, i) => list.splice(i, 1)[0]);
  trashJson(p.root, `comment-${removed.id}`, removed);
  return removed;
}
