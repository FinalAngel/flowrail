// Tiny DOM helpers. Text always goes in as text nodes, never as HTML.
import { icon } from '../icons.js';

/**
 * h('div.card', {onclick}, 'text', child)
 * Props starting with "on" become listeners; "class", "style" (string), "dataset" and aria-* are handled;
 * everything else is set as an attribute (false/null skipped).
 */
export function h(sel, props, ...kids) {
  const [tag, ...cls] = sel.split('.');
  const el = document.createElement(tag || 'div');
  if (cls.length) el.className = cls.join(' ');
  if (props != null && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = [el.className, v].filter(Boolean).join(' ');
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'hidden' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

export const clear = (el) => { el.replaceChildren(); return el; };
export { icon };

export function relTime(iso) {
  if (!iso) return '';
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = (Date.now() - t) / 1000, f = s < 0;
  const a = Math.abs(s);
  const out = a < 60 ? 'just now' : a < 3600 ? `${Math.round(a / 60)}\u00a0min` : a < 86400 ? `${Math.round(a / 3600)}\u00a0h` : a < 86400 * 30 ? `${Math.round(a / 86400)}\u00a0d` : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  if (out === 'just now' || a >= 86400 * 30) return out;
  return f ? `in ${out}` : `${out} ago`;
}

export const clock = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
export const day = (iso) => new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');

export async function copy(text, toast) {
  try { await navigator.clipboard.writeText(text); toast?.('Copied to clipboard'); }
  catch { toast?.('Copy failed. Select the text and copy it by hand.', 'warn'); }
}

/** A copyable mono command block. */
export function cmd(text, ctx) {
  return h('div.cmd', h('code', text), h('button.icon-btn', { type: 'button', 'aria-label': `Copy: ${text}`, title: 'Copy', onclick: () => copy(text, ctx?.toast) }, icon('copy')));
}

/** Empty state: one line of purpose, the exact CLI command, "Load example". */
export function empty(purpose, command, ctx, extra) {
  return h('div.empty',
    h('p', purpose),
    command && cmd(command, ctx),
    extra,
    h('button.link', { type: 'button', onclick: () => copy('npx @finalangel/flowrail-room demo', (m) => ctx?.toast?.(m === 'Copied to clipboard' ? 'Copied npx @finalangel/flowrail-room demo. Run it to open the example workspace.' : m)) }, 'Load example'));
}

/** Skeleton shaped like rows. */
export function skeleton(rows = 4, cls = '') {
  return h('div.skeleton', { class: cls, 'aria-busy': 'true', 'aria-label': 'Loading' }, Array.from({ length: rows }, (_, i) => h('div.sk-row', { style: `--w:${[88, 64, 76, 52, 70, 58][i % 6]}%` })));
}

export function errorBox(err, retry) {
  return h('div.error', { role: 'alert' },
    icon('alert'),
    h('div', h('strong', 'Could not load this. '), h('span', err?.message || String(err))),
    retry && h('button.btn.sm', { type: 'button', onclick: retry }, 'Try again'));
}

/**
 * Load-render helper: shows a skeleton, calls load(), then render(data). Errors render inline with retry.
 * Returns a reload function that keeps current content visible while refreshing.
 */
export function loader(el, load, render, rows) {
  let first = true, seq = 0;
  const run = async () => {
    const my = ++seq;
    if (first) clear(el).append(skeleton(rows));
    try {
      const data = await load();
      if (my !== seq || !el.isConnected) return;
      clear(el); render(data); first = false;
    } catch (e) {
      if (my !== seq || !el.isConnected) return;
      if (first) clear(el).append(errorBox(e, run));
      else console.warn('refresh failed', e);
    }
  };
  run();
  return run;
}

export function pageHead(title, sub, ...actions) {
  return h('header.page-head',
    h('div', h('h1', title), sub && h('p.sub', sub)),
    actions.length ? h('div.actions', actions) : null);
}

export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/** Side sheet using <dialog>. Returns {dialog, body, close}. */
export function sheet(title, build, { onClose } = {}) {
  const body = h('div.sheet-body');
  const close = () => d.close();
  const d = h('dialog.sheet', { 'aria-label': title },
    h('div.sheet-head', h('h2', title), h('button.icon-btn', { type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    body);
  d.addEventListener('close', () => { d.remove(); onClose?.(); });
  d.addEventListener('click', (e) => { if (e.target === d) close(); });
  document.body.append(d);
  build(body, close);
  d.showModal();
  return { dialog: d, body, close };
}

export function confirmBox(message, okLabel = 'Move to trash') {
  return new Promise((resolve) => {
    let ok = false;
    const d = h('dialog.confirm', { 'aria-label': 'Confirm' },
      h('p', message),
      h('div.row.end', h('button.btn', { type: 'button', onclick: () => d.close() }, 'Cancel'), h('button.btn.primary', { type: 'button', onclick: () => { ok = true; d.close(); } }, okLabel)));
    d.addEventListener('close', () => { d.remove(); resolve(ok); });
    document.body.append(d);
    d.showModal();
  });
}

export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

/**
 * A button waits on its own work: a ring turns where its icon is, and it takes no second press
 * until `promise` settles. Returns the promise, so callers can still await or catch it.
 */
export function busy(button, promise) {
  if (!button) return promise;
  button.classList.add('busy');
  button.setAttribute('aria-busy', 'true');
  const done = () => { button.classList.remove('busy'); button.removeAttribute('aria-busy'); };
  Promise.resolve(promise).then(done, done);
  return promise;
}

/**
 * Resolves when a run stops saying "running" (polls /api/runs/<id> every 2 s, gives up after two
 * minutes) with its last record, or null. `api` is ctx.api.
 */
export function waitForRun(api, id, { every = 2000, limit = 120000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = async () => {
      let run = null;
      try { run = await api('/runs/' + encodeURIComponent(id)); } catch { /* keep polling until the limit */ }
      if ((run && run.status !== 'running') || Date.now() - t0 >= limit) return resolve(run);
      setTimeout(tick, every);
    };
    tick();
  });
}

/** Hold a button until the run it started has finished. */
export const busyUntilRun = (button, api, id, opts) => busy(button, waitForRun(api, id, opts));

// Filters, switches and sorts remember their state per browser; search boxes never do.
const PREF = 'flowrail-f-';
export function pref(key, fallback) {
  try { const v = localStorage.getItem(PREF + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
}
export function savePref(key, value) {
  try { localStorage.setItem(PREF + key, JSON.stringify(value)); } catch { /* private mode: not remembered */ }
}

/**
 * A stacked bar with its legend: segments [{ label, n, tone }] (tone: accent, info, warn, danger,
 * muted) drawn in proportion, and "n label" for each under it; `bar: false` keeps one out of the bar. Shared by list pages (Backlog, and
 * plugin pages like a leads table) so their summaries look the same.
 */
export function statbar(segments) {
  // A segment with bar: false is only in the legend (a count that overlaps the others).
  const shown = segments.filter((x) => x.n > 0 && x.bar !== false);
  return h('div.statbar',
    h('div.statbar-bar', { role: 'img', 'aria-label': shown.map((x) => `${x.n} ${x.label}`).join(', ') },
      shown.map((x) => h('span', { class: `tone-${x.tone || 'muted'}`, style: `flex-grow:${x.n}`, title: `${x.n} ${x.label}` }))),
    h('div.statbar-legend', segments.map((x) => h('span', { class: `tone-${x.tone || 'muted'}` }, h('span.dot'), h('b', x.n), ` ${x.label}`))));
}
