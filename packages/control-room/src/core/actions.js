// Actions: commands with inputs, listed in flowrail/config.json "actions" (record a meeting from a
// link, build a report for a client). The list is file-only, like apps and command routines: the
// API runs an action by id and can never add one or change what it runs. A run fills each "{name}"
// placeholder with its checked input value as one whole argv element: nothing reaches a shell, and a
// value is never split, joined into another argument, or read as an option.
import { loadConfig } from 'flowrail/api';
import * as runs from './runs.js';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const TYPES = ['text', 'url', 'select'];
const NAME = /^[a-z][a-z0-9_]{0,31}$/;
const HOLE = /^\{([a-z][a-z0-9_]{0,31})\}$/;

/** Problems with an "actions" array, as sentences; [] when it is fine. */
export function validate(actions) {
  if (actions === undefined) return [];
  if (!Array.isArray(actions)) return ['actions must be a JSON array'];
  const errors = [];
  const ids = new Set();
  actions.forEach((a, i) => {
    const at = `action ${i + 1}${a && a.id ? ` (${a.id})` : ''}`;
    if (!a || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(a.id || '')) { errors.push(`${at}: id must be a lowercase slug`); return; }
    if (ids.has(a.id)) errors.push(`${at}: duplicate id`);
    ids.add(a.id);
    if (typeof a.title !== 'string' || !a.title.trim()) errors.push(`${at}: title is required`);
    const inputs = a.inputs ?? [];
    if (!Array.isArray(inputs)) { errors.push(`${at}: inputs must be an array`); return; }
    const names = new Set();
    for (const f of inputs) {
      if (!f || !NAME.test(f.name || '')) { errors.push(`${at}: every input needs a name like "url"`); continue; }
      names.add(f.name);
      if (f.type !== undefined && !TYPES.includes(f.type)) errors.push(`${at}: input ${f.name}: type must be ${TYPES.join(', ')}`);
      if (f.type === 'select' && !(Array.isArray(f.options) && f.options.length && f.options.every((o) => typeof o === 'string'))) errors.push(`${at}: input ${f.name}: a select needs options`);
      if (f.pattern !== undefined) { try { new RegExp(f.pattern); } catch { errors.push(`${at}: input ${f.name}: pattern does not compile`); } }
    }
    if (!Array.isArray(a.cmd) || !a.cmd.length || !a.cmd.every((w) => typeof w === 'string' && w)) { errors.push(`${at}: cmd must be an argv array`); return; }
    if (HOLE.test(a.cmd[0])) errors.push(`${at}: the program itself cannot be an input`);
    for (const w of a.cmd) {
      const m = HOLE.exec(w);
      if (m && !names.has(m[1])) errors.push(`${at}: cmd uses {${m[1]}}, which is not an input`);
      else if (!m && /\{[a-z][a-z0-9_]*\}/.test(w)) errors.push(`${at}: "${w}": an input fills a whole argument, not part of one`);
    }
  });
  return errors;
}

function configured(p) {
  const actions = loadConfig(p).actions;
  const errors = validate(actions);
  if (errors.length) throw bad(`flowrail/config.json: ${errors.join('; ')}`, 422);
  return actions || [];
}

export const list = (p) => configured(p).map(({ id, title, description, inputs, cmd }) => ({ id, title, description: description || '', inputs: inputs || [], cmd }));

/** The argv for one run: every value checked, then placed as a whole element. Throws 400 with the reason. */
export function argv(action, given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw bad('inputs must be an object');
  const inputs = action.inputs || [];
  const unknown = Object.keys(given).filter((k) => !inputs.some((f) => f.name === k));
  if (unknown.length) throw bad(`unknown input ${unknown.join(', ')}`);
  const values = {};
  for (const f of inputs) {
    const label = f.label || f.name;
    const v = given[f.name] === undefined || given[f.name] === null ? '' : String(given[f.name]).trim();
    if (!v) { if (f.required) throw bad(`${label} is required`); values[f.name] = ''; continue; }
    if (v.length > (Number(f.max) || 500)) throw bad(`${label} is longer than ${Number(f.max) || 500} characters`);
    if (/[\0-\x1f\x7f]/.test(v)) throw bad(`${label} must be one line of plain text`);
    if (f.type === 'select') {
      if (!f.options.includes(v)) throw bad(`${label} must be one of ${f.options.join(', ')}`);
      values[f.name] = v; // the options come from config.json
      continue;
    }
    // A value that starts with "-" would reach the program as an option of its own.
    if (v.startsWith('-')) throw bad(`${label} cannot start with "-"`);
    if (f.type === 'url') {
      let u;
      try { u = new URL(v); } catch { throw bad(`${label} must be a link`); }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') throw bad(`${label} must be an http or https link`);
    }
    if (f.pattern !== undefined && !new RegExp(f.pattern).test(v)) throw bad(`${label} does not match ${f.pattern}`);
    values[f.name] = v;
  }
  return action.cmd.map((w) => { const m = HOLE.exec(w); return m ? values[m[1]] : w; });
}

/** Start an action as a run (one run at a time, recorded like every other run). */
export function run(p, id, given) {
  const action = configured(p).find((a) => a.id === id);
  if (!action) throw bad(`no action ${id}; actions are added in flowrail/config.json only`, 404);
  const cmd = argv(action, given);
  const r = runs.start(p, { kind: 'command', cmd }, { title: action.title });
  r.done.catch(() => {});
  return { id: r.id, record: r.record };
}
