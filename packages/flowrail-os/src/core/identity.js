// Who is at this keyboard: git's user.email in the repo, named from the people folder when a profile
// lists that address, else git's user.name. Every comment, note, resolution and journal line records
// it, so a second person on the repo is someone, not "you".
// "shared": true in flowrail/config.json keeps comments and the activity journal in flowrail/
// (committed) instead of .flowrail/ (this machine only).
import { execFileSync } from 'node:child_process';
import { loadConfig } from 'flowrail/api';
import { people } from './team.js';

const cache = new Map();

function git(root, key) {
  try {
    return execFileSync('git', ['config', key], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 }).trim();
  } catch { return ''; }
}

/** { email, name } for the person at this keyboard; email '' when git has none. Cached per root. */
export function me(p) {
  if (cache.has(p.root)) return cache.get(p.root);
  const email = git(p.root, 'user.email').toLowerCase();
  let name = '';
  try { name = email ? people(p).find((x) => x.email.toLowerCase() === email)?.name || '' : ''; } catch { /* no people folder */ }
  const who = { email, name: name || git(p.root, 'user.name') || 'you' };
  cache.set(p.root, who);
  return who;
}

/** A display name for an email in the people folder, else the email itself. */
export function nameFor(p, email) {
  if (!email) return '';
  try { return people(p).find((x) => x.email.toLowerCase() === String(email).toLowerCase())?.name || email; } catch { return email; }
}

export const shared = (p) => loadConfig(p).shared === true;
