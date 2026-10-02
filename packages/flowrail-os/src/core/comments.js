// Comments on documents. A comment is an instruction for the agent; the agent resolves it after acting.
// Where: with "shared": true in flowrail/config.json, one file per comment in flowrail/comments/<id>.json
// (committed, so everyone on the repo sees it and two people never conflict); otherwise per machine in
// .flowrail/comments/<encoded-path>.json. Both are always read, so switching loses nothing.
// Trust: a comment added through the dashboard is HMAC-signed with this machine's key and, signed by its
// person, with their ed25519 key; it is `verified` when either checks out (the person's public key in
// config.json "keys"). A comment an agent wrote by hand shows as unverified.
import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, nowIso, randomId, listFiles, trashJson, loadConfig } from 'flowrail/api';
import { signComment, commentVerified, signAsPerson, personVerified } from 'flowrail/api';
import { me, shared } from './identity.js';
import { record } from './journal.js';

const legacyFile = (p, rel) => path.join(p.comments, encodeURIComponent(rel) + '.json');
const sharedDir = (p) => path.join(p.root, 'flowrail', 'comments');
const sharedFile = (p, id) => path.join(sharedDir(p), `${id}.json`);

function loadLegacy(p, rel) {
  const list = readJson(legacyFile(p, rel), []);
  return Array.isArray(list) ? list : [];
}

function loadShared(p) {
  return listFiles(sharedDir(p), '.json').map((n) => readJson(path.join(sharedDir(p), n), null))
    .filter((c) => c && typeof c === 'object' && typeof c.id === 'string');
}

const verify = (c, keys) => { try { return !!commentVerified(c) || personVerified(c, keys); } catch { return false; } };
/** The stored comment plus `verified`. */
const trustWith = (p) => { const keys = loadConfig(p).keys; return (c) => ({ ...c, verified: verify(c, keys) }); };
const byCreated = (a, b) => String(a.created).localeCompare(String(b.created));

export const forPath = (p, rel) => [...loadLegacy(p, rel), ...loadShared(p).filter((c) => c.path === rel)].map(trustWith(p)).sort(byCreated);

export function all(p) {
  const out = [];
  for (const name of listFiles(p.comments, '.json')) {
    const list = readJson(path.join(p.comments, name), []);
    if (Array.isArray(list)) out.push(...list);
  }
  return [...out, ...loadShared(p)].map(trustWith(p)).sort(byCreated);
}

export const open = (p) => all(p).filter((c) => c.status === 'open');

function saveLegacy(p, rel, list) {
  if (list.length) writeJson(legacyFile(p, rel), list);
  else fs.rmSync(legacyFile(p, rel), { force: true });
}

export function add(p, { path: rel, quote = '', body, author, anchor, createdBy = 'human' }) {
  if (!rel || typeof rel !== 'string') throw Object.assign(new Error('path is required'), { status: 400 });
  if (!body || !String(body).trim()) throw Object.assign(new Error('comment body is required'), { status: 400 });
  const who = me(p);
  const c = {
    id: `c-${randomId(3)}`,
    path: rel,
    quote: String(quote).slice(0, 2000),
    ...(anchor && Number.isInteger(anchor.start) && Number.isInteger(anchor.end) ? { anchor: { start: anchor.start, end: anchor.end } } : {}),
    body: String(body).slice(0, 10000),
    author: String(author || who.name).slice(0, 80),
    ...(who.email ? { email: who.email } : {}),
    createdBy,
    created: nowIso(),
    status: 'open',
  };
  if (createdBy === 'human') {
    c.sig = signComment(c);
    if (c.email) c.signature = signAsPerson(c);
  }
  if (shared(p)) writeJson(sharedFile(p, c.id), c);
  else saveLegacy(p, rel, [...loadLegacy(p, rel), c]);
  record(p, { kind: 'comment', action: 'added', id: c.id, path: rel, by: createdBy });
  return trustWith(p)(c);
}

/** Change one comment where it is stored (shared file or the legacy list) and save it there. */
function mutate(p, rel, id, fn) {
  const file = sharedFile(p, id);
  const one = /^c-[\w-]+$/.test(id) ? readJson(file, null) : null;
  if (one && one.path === rel) {
    const list = [one];
    const result = fn(list, 0);
    if (list.length) writeJson(file, list[0]);
    else fs.rmSync(file, { force: true });
    return result;
  }
  const list = loadLegacy(p, rel);
  const i = list.findIndex((c) => c.id === id);
  if (i === -1) throw Object.assign(new Error(`no comment ${id} on ${rel}`), { status: 404 });
  const result = fn(list, i);
  saveLegacy(p, rel, list);
  return result;
}

export function resolve(p, rel, id, note, by = 'agent') {
  const c = mutate(p, rel, id, (list, i) => {
    Object.assign(list[i], { status: 'resolved', resolvedAt: nowIso(), resolvedBy: by });
    if (note) list[i].resolveNote = String(note).slice(0, 4000);
    return trustWith(p)(list[i]);
  });
  record(p, { kind: 'comment', action: 'resolved', id, path: rel, by: /^(agent|claude)$/i.test(by) ? 'agent' : 'human' });
  return c;
}

export function reopen(p, rel, id) {
  return mutate(p, rel, id, (list, i) => {
    list[i].status = 'open';
    delete list[i].resolvedAt;
    delete list[i].resolveNote;
    delete list[i].resolvedBy;
    return trustWith(p)(list[i]);
  });
}

export function remove(p, rel, id) {
  const removed = mutate(p, rel, id, (list, i) => list.splice(i, 1)[0]);
  trashJson(p.root, `comment-${removed.id}`, removed);
  return removed;
}
