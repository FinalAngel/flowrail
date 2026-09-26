// flowrail app shell: hash router, API helper, live refresh over SSE, command palette, theme, toasts.
import { h, icon, clear, copy, cmd, debounce, plural } from './lib/dom.js';

/* ---------- API ---------- */
// Per-launch token the server writes into index.html. It never touches disk or localStorage.
const TOKEN = document.querySelector('meta[name="flowrail-token"]')?.content || '';
let stale = false;
export async function api(path, body) {
  const headers = { 'X-Flowrail-Token': TOKEN };
  const init = body === undefined
    ? { headers }
    : { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'X-Flowrail': '1' }, body: JSON.stringify(body) };
  let res;
  try { res = await fetch('/api' + path, init); }
  catch { throw new Error('The flowrail server is not reachable. Is `npx @finalangel/flowrail-room` still running?'); }
  if (res.status === 401) { showStale(); const e = new Error('This tab is from an older flowrail run. Reload.'); e.status = 401; throw e; }
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = txt; }
  if (!res.ok) {
    const e = new Error((data && (data.error || data.message)) || `${res.status} ${res.statusText}`);
    e.status = res.status; e.data = data;
    throw e;
  }
  return data;
}

/** The server restarted with a new token: this tab can no longer talk to it. One calm full-page state. */
function showStale() {
  if (stale) return;
  stale = true;
  es?.close();
  document.querySelectorAll('dialog').forEach((d) => d.remove());
  document.getElementById('shell').replaceChildren(h('div.stale', { role: 'alert' },
    icon('mark', 28),
    h('h1', 'This tab is from an older flowrail run. Reload.'),
    h('p.muted', 'flowrail was restarted, so this page lost its connection. Reloading picks up the new run. Nothing was lost.'),
    h('button.btn.primary', { type: 'button', onclick: () => location.reload() }, 'Reload')));
  document.title = 'Reload · flowrail';
}

/* ---------- Toasts ---------- */
export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div.toast', { class: kind }, kind === 'warn' ? icon('alert') : icon('check'), h('span', message));
  box.append(t);
  setTimeout(() => t.remove(), kind === 'warn' ? 6000 : 3200);
}

/* ---------- Pages ---------- */
const NAV = [
  ['Now', [['dashboard', 'Dashboard', '/'], ['board', 'Board', '/board']]],
  ['Knowledge', [['docs', 'Docs', '/docs'], ['graph', 'Graph', '/knowledge'], ['memory', 'Memory', '/memory'], ['artifacts', 'Artifacts', '/artifacts']]],
  ['Automation', [['routines', 'Routines', '/routines'], ['workflows', 'Workflows', '/workflows'], ['team', 'Team', '/team']]],
  ['Safety', [['redlines', 'Red lines', '/redlines'], ['security', 'Security', '/security']]],
];
const SETTINGS = ['settings', 'Settings', '/settings'];
const PAGES = [...NAV.flatMap(([, items]) => items), SETTINGS];
const ALIAS = { '/graph': '/knowledge', '/dashboard': '/' };
const ICON = { dashboard: 'dashboard', board: 'board', docs: 'docs', graph: 'graph', memory: 'memory', artifacts: 'artifacts', routines: 'routines', workflows: 'workflows', team: 'team', redlines: 'redlines', security: 'security', settings: 'settings' };

function parseHash() {
  const raw = decodeURI(location.hash.slice(1)) || '/';
  const q = raw.indexOf('?');
  const path = (q < 0 ? raw : raw.slice(0, q)) || '/';
  return { path: ALIAS[path] || path, params: new URLSearchParams(q < 0 ? '' : location.hash.slice(location.hash.indexOf('?') + 1)) };
}
export const navigate = (href) => { location.hash = href.replace(/^#/, ''); };

/* ---------- Live events ---------- */
const listeners = new Set();
let es;
function connectEvents() {
  try {
    es = new EventSource('/api/events?token=' + encodeURIComponent(TOKEN));
    es.addEventListener('change', (e) => {
      let area; try { area = JSON.parse(e.data).area; } catch { area = undefined; }
      for (const fn of listeners) fn(area);
    });
  } catch { /* SSE unsupported: pages still work, just without live refresh */ }
}

/* ---------- Shell state ---------- */
const shell = { overview: null, redlines: null };
const content = () => document.getElementById('content');

async function refreshShell() {
  if (stale) return;
  const [ov, rl] = await Promise.allSettled([api('/overview'), api('/redlines')]);
  if (ov.status === 'fulfilled') shell.overview = ov.value;
  if (rl.status === 'fulfilled') shell.redlines = rl.value;
  renderSidebar(); renderTopbar(); renderBanner();
}
/** { installed, healthy, where, command, problem } from the server; older servers only send a boolean. */
export const hooksInfo = () => {
  const o = shell.overview, r = shell.redlines;
  const x = [o?.hooks, r?.hooks].find((v) => v && typeof v === 'object' && 'installed' in v);
  if (x) return { ...x, healthy: x.healthy ?? x.installed };
  const b = typeof r?.hooksInstalled === 'boolean' ? r.hooksInstalled : typeof o?.hooksInstalled === 'boolean' ? o.hooksInstalled : null;
  return b == null ? null : { installed: b, healthy: b };
};
/** true = the guard enforces red lines, false = missing, broken or its files changed, null = unknown yet. */
export const hooksState = () => { const x = hooksInfo(); return x ? !!(x.installed && x.healthy && x.guard?.verified !== false) : null; };
export const isArmed = (line, hooks) => (line.state ? line.state === 'armed' : !!(line.hook && (line.hook.match || line.hook.builtin)) && hooks !== false);

// Modules switched off in flowrail/config.json leave the sidebar (the page stays reachable by URL).
const MODULE_OF = { graph: 'knowledge' };
const on = ([id]) => shell.overview?.workspace?.modules?.[MODULE_OF[id] || id] !== false;

function renderSidebar() {
  const side = document.getElementById('sidebar');
  const { path } = parseHash();
  const c = shell.overview?.counts || {};
  const lines = shell.redlines?.lines || [];
  const hooks = hooksState();
  const armed = lines.filter((l) => isArmed(l, hooks)).length;
  const badge = (id) => {
    if (id === 'board' && c.inProgress) return h('span.count', { 'aria-label': `${c.inProgress} in progress` }, c.inProgress);
    if (id === 'docs' && c.commentsOpen) return h('span.count', { 'aria-label': `${plural(c.commentsOpen, 'open comment')}` }, c.commentsOpen);
    if (id === 'routines' && c.routinesFailed) return h('span.count.warn', { 'aria-label': `${c.routinesFailed} failed` }, c.routinesFailed);
    if (id === 'redlines' && lines.length) return hooks === false
      ? h('span.rail.off', { 'aria-label': 'guard not enforcing' }, icon('shieldOff', 13), 'off')
      : h('span.rail', { 'aria-label': `${armed} armed` }, icon('shield', 13), armed);
    return null;
  };
  const link = ([id, label, href]) => h('a', { href: '#' + href, 'aria-current': path === href ? 'page' : null, onclick: closeNav }, icon(ICON[id]), h('span', label), badge(id));
  clear(side).append(
    h('a.brand', { href: '#/', 'aria-label': 'flowrail home', onclick: closeNav }, icon('mark', 20), h('span.wordmark', h('span.f', 'flow'), h('span.r', 'rail'))),
    h('nav.nav', { 'aria-label': 'Pages' }, NAV.map(([group, items]) => [group, items.filter(on)]).filter(([, items]) => items.length).map(([group, items]) => h('div.nav-group', { role: 'group', 'aria-label': group }, h('div.nav-label', { 'aria-hidden': 'true' }, group), items.map(link)))),
    h('div.sidebar-foot.nav', link(SETTINGS), shell.overview?.workspace?.version && h('div.ver', 'v' + shell.overview.workspace.version)),
  );
}

function renderTopbar() {
  const bar = document.getElementById('topbar');
  const ov = shell.overview;
  const ws = ov?.workspace || {};
  const git = ov?.git;
  const hi = hooksInfo();
  // Below 768px the pill collapses to its dot; the aria-label keeps the full state.
  const pill = (cls, label, title, fix) => h('a.hooks', { class: cls, href: '#/redlines', title, 'aria-label': label + (fix ? '. Fix' : '') },
    h('span.dot'), h('span.lbl', fix ? `${label} → Fix` : label));
  const changed = hi?.guard && hi.guard.verified === false;
  const hooksEl = !hi ? h('span.hooks.unknown', { 'aria-label': 'Guard state unknown' }, h('span.dot'), h('span.lbl', 'Guard unknown'))
    : !hi.installed ? pill('off', 'Guard not installed', 'Red lines are written down but nothing enforces them yet', true)
      : changed ? h('button.hooks.off', { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Guard files changed. Fix', onclick: (e) => guardPopover(e.currentTarget, hi) },
        h('span.dot'), h('span.lbl', 'Guard files changed → Fix'))
        : !hi.healthy ? pill('off', 'Guard broken', hi.problem || 'The guard command in .claude/settings.json does not run, so red lines are not enforced.', true)
          : pill('live', 'Guard live', `The guard runs from ${hi.where || '.claude/settings.json'}${hi.guard?.version ? `, version ${hi.guard.version}, files verified` : ''}`);
  clear(bar).append(
    h('button.icon-btn.menu-btn', { type: 'button', 'aria-label': 'Open menu', 'aria-controls': 'sidebar', 'aria-expanded': String(document.getElementById('shell').classList.contains('nav-open')), onclick: openNav }, icon('menu')),
    h('div.repo',
      h('span.name', { title: ws.root || '' }, ws.name || 'flowrail'),
      git && git.branch && h('span.branch', icon('branch', 14), git.branch, git.dirty ? h('span.dirty', { title: `${git.dirty} changed files` }, ` +${git.dirty}`) : null)),
    h('button.search-btn', { type: 'button', onclick: openPalette, 'aria-label': 'Search and commands', 'aria-keyshortcuts': 'Meta+K Control+K' }, icon('search'), h('span.lbl', 'Search…'), h('kbd', navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl K')),
    themeButton(),
    hooksEl,
  );
}

/** The vendored guard no longer matches its manifest: say which files, and the one command that restores them. */
function guardPopover(anchor, hi) {
  document.querySelector('.popover')?.remove();
  const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); anchor.focus(); };
  const outside = (e) => { if (!pop.contains(e.target) && e.target !== anchor) close(); };
  const files = hi.guard?.changed || [];
  const pop = h('div.popover.guard-pop', { role: 'dialog', 'aria-label': 'Guard files changed', tabindex: '-1', onkeydown: (e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } } },
    h('p.gp-title', icon('shieldOff', 16), 'Red lines are not enforced'),
    h('p.meta', files.length ? `These guard ${files.length === 1 ? 'file no longer matches' : 'files no longer match'} the version flowrail installed:` : 'The guard files no longer match the version flowrail installed.'),
    files.length > 0 && h('ul.gp-files', files.map((f) => h('li.mono', f))),
    h('p.meta', 'Restore them from the package, then check the diff before you commit:'),
    cmd('npx flowrail upgrade', { toast }));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const w = Math.min(360, innerWidth - 16);
  pop.style.width = w + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
  pop.style.top = (r.bottom + 8) + 'px';
  requestAnimationFrame(() => { document.addEventListener('pointerdown', outside, true); pop.focus(); });
}

function renderBanner() {
  const b = document.getElementById('banner');
  const ov = shell.overview;
  const demo = ov?.workspace?.demo ?? ov?.demo ?? ov?.config?.demo;
  clear(b);
  if (demo && !document.documentElement.dataset.shot) b.append(h('div.banner', { role: 'note' }, icon('alert', 14), 'Example workspace. Nothing here touches your repo.'));
}

/* ---------- Mobile nav sheet ---------- */
function openNav() {
  const s = document.getElementById('shell');
  s.classList.add('nav-open');
  if (!document.querySelector('.scrim')) document.body.append(h('div.scrim', { onclick: closeNav }));
  document.querySelector('.menu-btn')?.setAttribute('aria-expanded', 'true');
  requestAnimationFrame(() => document.querySelector('#sidebar a')?.focus());
}
function closeNav() {
  const s = document.getElementById('shell');
  if (!s.classList.contains('nav-open')) return;
  s.classList.remove('nav-open');
  document.querySelector('.scrim')?.remove();
  const m = document.querySelector('.menu-btn');
  m?.setAttribute('aria-expanded', 'false');
}

/* ---------- Theme ---------- */
const THEMES = ['system', 'light', 'dark'];
function getTheme() { try { const t = localStorage.getItem('flowrail-theme'); return THEMES.includes(t) ? t : 'system'; } catch { return 'system'; } }
function setTheme(t) {
  try { if (t === 'system') localStorage.removeItem('flowrail-theme'); else localStorage.setItem('flowrail-theme', t); } catch { /* private mode */ }
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  window.dispatchEvent(new Event('flowrail:theme'));
  renderTopbar();
}
function themeButton() {
  const t = getTheme();
  const next = THEMES[(THEMES.indexOf(t) + 1) % 3];
  return h('button.icon-btn', { type: 'button', 'aria-label': `Theme: ${t}. Switch to ${next}`, title: `Theme: ${t}`, onclick: () => setTheme(next) }, icon(t === 'light' ? 'sun' : t === 'dark' ? 'moon' : 'monitor'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => window.dispatchEvent(new Event('flowrail:theme')));

/* ---------- Command palette ---------- */
let palette;
function openPalette() {
  if (palette?.open) return;
  closeNav();
  const input = h('input', { type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'pal-list', 'aria-autocomplete': 'list', 'aria-label': 'Search pages, docs, tasks and memory', placeholder: 'Go to, run or recall…', autocomplete: 'off', spellcheck: 'false' });
  const list = h('div.palette-list', { id: 'pal-list', role: 'listbox', 'aria-label': 'Results' });
  palette = h('dialog.palette', { 'aria-label': 'Command palette' },
    h('div.palette-input', icon('search'), input, h('kbd', 'esc')),
    list,
    h('div.palette-foot', h('span', h('kbd', '↑'), ' ', h('kbd', '↓'), ' move'), h('span', h('kbd', '↵'), ' open'), h('span', 'Run items copy the command')));
  let items = [], active = 0, seq = 0;
  const choose = (it) => { palette.close(); if (it.href) navigate(it.href); else if (it.copy) copy(it.copy, toast); };
  const paint = () => {
    clear(list);
    let sec = null;
    items.forEach((it, i) => {
      if (it.section !== sec) { sec = it.section; list.append(h('div.palette-sec', { role: 'presentation' }, sec)); }
      list.append(h('div.palette-opt', { id: `pal-${i}`, role: 'option', 'aria-selected': String(i === active), onclick: () => choose(it), onmousemove: () => { if (active !== i) { active = i; mark(); } } },
        icon(it.icon), h('span.t', { class: it.mono ? 'mono' : '' }, it.title), it.kind && h('span.k', it.kind)));
    });
    if (!items.length) list.append(h('div.palette-sec', { role: 'presentation' }, 'Nothing matches. Try fewer words.'));
    mark();
  };
  const mark = () => {
    list.querySelectorAll('[role=option]').forEach((o, i) => o.setAttribute('aria-selected', String(i === active)));
    input.setAttribute('aria-activedescendant', items.length ? `pal-${active}` : '');
    list.querySelector(`#pal-${active}`)?.scrollIntoView({ block: 'nearest' });
  };
  const KIND_ICON = { doc: 'docs', task: 'board', memory: 'memory', artifact: 'artifacts', routine: 'routines', workflow: 'workflows', redline: 'redlines', agent: 'team' };
  const update = async () => {
    const q = input.value.trim();
    const my = ++seq;
    const ql = q.toLowerCase();
    const go = PAGES.filter(([, label]) => !ql || label.toLowerCase().includes(ql)).map(([id, label, href]) => ({ section: 'Go to', title: label, href, icon: ICON[id], kind: 'page' }));
    const quoted = q.replace(/"/g, '\\"');
    const slug = ql.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'fact';
    const run = q
      ? [
          { section: 'Run', title: `npx @finalangel/flowrail-room task "${quoted}"`, copy: `npx @finalangel/flowrail-room task "${quoted}"`, icon: 'terminal', mono: true, kind: 'file a task' },
          { section: 'Run', title: `npx @finalangel/flowrail-room recall "${quoted}"`, copy: `npx @finalangel/flowrail-room recall "${quoted}"`, icon: 'terminal', mono: true, kind: 'recall' },
          { section: 'Run', title: `npx @finalangel/flowrail-room remember "${quoted}" --type project --name ${slug}`, copy: `npx @finalangel/flowrail-room remember "${quoted}" --type project --name ${slug}`, icon: 'terminal', mono: true, kind: 'remember' },
        ]
      : ['npx @finalangel/flowrail-room status', 'npx flowrail doctor', 'npx flowrail redlines test "git push origin main"', 'npx flowrail check'].map((c) => ({ section: 'Run', title: c, copy: c, icon: 'terminal', mono: true }));
    items = [...go, ...run];
    active = 0; paint();
    if (q.length < 2) return;
    const [found, recall] = await Promise.allSettled([api('/search?q=' + encodeURIComponent(q)), q.length >= 3 ? api('/recall?q=' + encodeURIComponent(q)) : Promise.resolve(null)]);
    if (my !== seq || !palette.open) return;
    const hits = found.status === 'fulfilled' ? (Array.isArray(found.value) ? found.value : found.value?.results || []) : [];
    const rc = recall.status === 'fulfilled' && recall.value ? (recall.value.hits || []).slice(0, 4) : [];
    items = [
      ...go,
      ...hits.slice(0, 8).map((x) => ({ section: 'Go to', title: x.title, href: x.href, icon: KIND_ICON[x.kind] || 'file', kind: x.kind })),
      ...run,
      ...rc.map((x) => ({ section: 'Recall', title: x.snippet || x.name || x.path, href: x.source === 'doc' || (x.path && !String(x.path).includes('memory/')) ? '#/docs?path=' + encodeURIComponent(x.path) : '#/memory?q=' + encodeURIComponent(q), icon: 'memory', kind: x.name || x.path })),
    ];
    paint();
  };
  const upd = debounce(update, 120);
  input.addEventListener('input', upd);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); mark(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); mark(); e.preventDefault(); }
    else if (e.key === 'Home' && e.altKey) { active = 0; mark(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (items[active]) choose(items[active]); }
  });
  palette.addEventListener('close', () => palette.remove());
  palette.addEventListener('click', (e) => { if (e.target === palette) palette.close(); });
  document.body.append(palette);
  palette.showModal();
  update();
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (palette?.open) palette.close(); else openPalette(); return; }
  if (e.key === 'Escape') closeNav();
  const t = e.target;
  const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !document.querySelector('dialog[open]')) { e.preventDefault(); openPalette(); }
});

/* ---------- Router ---------- */
let current = null, routeSeq = 0, firstRoute = true;

async function route() {
  if (stale) return;
  const { path, params } = parseHash();
  const page = PAGES.find(([, , href]) => href === path);
  renderSidebar();
  closeNav();
  if (current && page && current.id === page[0] && typeof current.unmount?.update === 'function') { current.unmount.update(params); return; }
  const my = ++routeSeq;
  if (current) { try { current.unmount?.(); } catch (e) { console.error(e); } current.dispose.forEach((f) => f()); current = null; }
  document.querySelectorAll('dialog.sheet, .popover').forEach((d) => d.remove());
  const el = content();
  clear(el);
  if (!page) {
    document.title = 'Not found · flowrail';
    el.append(h('div.empty', h('h1', 'This page does not exist'), h('p', `Nothing lives at ${path}.`), h('a.btn', { href: '#/' }, 'Back to the dashboard')));
    return;
  }
  document.title = `${page[1]} · flowrail`;
  let mod;
  try { mod = await import(`./pages/${page[0]}.js`); }
  catch (e) { if (my === routeSeq) el.append(h('div.error', { role: 'alert' }, icon('alert'), `Could not load the ${page[1]} page. ${e.message}`)); return; }
  if (my !== routeSeq) return;
  const dispose = [];
  const ctx = {
    api, toast, navigate, params, shell, hooksState, hooksInfo, isArmed,
    refreshShell: () => refreshShell(),
    /** Subscribe to live changes. areas: array of area names or null for all. Debounced; auto-removed on page change. */
    on(areas, fn) {
      const run = debounce(fn, 200);
      const f = (area) => { if (!areas || !area || areas.includes(area)) run(area); };
      listeners.add(f);
      dispose.push(() => listeners.delete(f));
    },
    cleanup(fn) { dispose.push(fn); },
  };
  let unmount;
  try { unmount = mod.mount(el, ctx); }
  catch (e) { console.error(e); el.append(h('div.error', { role: 'alert' }, icon('alert'), `The ${page[1]} page failed to start. ${e.message}`)); }
  current = { id: page[0], unmount, dispose };
  if (!firstRoute) el.focus({ preventScroll: true });
  if (!firstRoute) window.scrollTo(0, 0);
  firstRoute = false;
}

window.addEventListener('hashchange', route);
listeners.add(debounce(() => refreshShell(), 400));
renderSidebar(); renderTopbar();
route();
refreshShell();
connectEvents();
