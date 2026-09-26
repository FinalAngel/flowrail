import { h, icon, clear, loader, debounce, empty, shortDate, plural } from '../lib/dom.js';

// Every Markdown document, grouped by area, with how long ago it last changed.
const STATES = [['fresh', 'Fresh'], ['aging', 'Aging'], ['stale', 'Stale']];
const NONE = 'No area';
const docHref = (p) => '#/docs?path=' + encodeURIComponent(p);
const age = (d) => (d === null || d === undefined ? '' : d === 0 ? 'today' : d < 60 ? `${d} d` : d < 730 ? `${Math.round(d / 30)} mo` : `${Math.round(d / 365)} y`);

export function mount(el, ctx) {
  let data = null;
  let q = '', area = ctx.params.get('area') || '', state = ctx.params.get('state') || '', sort = 'days', dir = -1;
  const root = h('div');
  el.append(root);
  const body = h('div');

  const search = h('input.input.search', { type: 'search', placeholder: 'Filter by title or path', 'aria-label': 'Filter documents', autocomplete: 'off', oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120) });
  const areaSel = h('select.input', { 'aria-label': 'Area', onchange: (e) => { area = e.target.value; paint(); } });
  const stateSel = h('select.input', { 'aria-label': 'State', onchange: (e) => { state = e.target.value; paint(); } },
    h('option', { value: '' }, 'Every state'), STATES.map(([v, l]) => h('option', { value: v }, l)));

  function bar(counts) {
    const total = STATES.reduce((n, [s]) => n + counts[s], 0) || 1;
    return h('div.stale-bar', { role: 'group', 'aria-label': 'Documents by staleness' },
      h('div.stale-track', STATES.map(([s]) => counts[s] ? h('i', { class: s, style: `flex-grow:${counts[s] / total}` }) : null)),
      h('div.stale-keys', STATES.map(([s, label]) => h('button.stale-key', { type: 'button', class: s, 'aria-pressed': String(state === s), onclick: () => { state = state === s ? '' : s; stateSel.value = state; paint(); } },
        h('span.dot'), `${counts[s]} ${label.toLowerCase()}`))));
  }

  const th = (key, label, cls) => h('th', { class: cls, 'aria-sort': sort === key ? (dir > 0 ? 'ascending' : 'descending') : null },
    h('button.th-sort', { type: 'button', onclick: () => { dir = sort === key ? -dir : key === 'title' ? 1 : -1; sort = key; paint(); } }, label, sort === key ? (dir > 0 ? ' ↑' : ' ↓') : ''));

  function table(docs) {
    const rows = [...docs].sort((a, b) => {
      const x = sort === 'title' ? a.title.localeCompare(b.title) : (a.days ?? -1) - (b.days ?? -1);
      return x * dir || a.path.localeCompare(b.path);
    });
    return h('div.table-wrap', h('table.tbl.lib-tbl',
      h('thead', h('tr', th('title', 'Document'), h('th.lib-path', 'Path'), th('days', 'Changed', 'fig'), h('th', 'State'))),
      h('tbody', rows.map((d) => h('tr',
        h('td', h('a.lib-title', { href: docHref(d.path) }, d.title)),
        h('td.lib-path.mono', d.path),
        h('td.fig', { title: d.changed ? new Date(d.changed).toLocaleString() : '' }, d.changed ? `${shortDate(d.changed)} · ${age(d.days)}` : '', d.uncommitted ? h('span.faint', { title: 'Changed since the last commit' }, ' *') : null),
        h('td', h('span.status', { class: d.state === 'stale' ? 'danger' : d.state === 'aging' ? 'warn' : d.state === 'fresh' ? 'ok' : 'idle' }, h('span.dot'), d.state)))))));
  }

  function paint() {
    if (!data) return;
    root.querySelectorAll('.stale-key').forEach((b) => b.setAttribute('aria-pressed', String(b.classList.contains(state))));
    const docs = data.docs.filter((d) => (!q || d.title.toLowerCase().includes(q) || d.path.toLowerCase().includes(q)) && (!state || d.state === state));
    clear(body);
    const groups = data.areas.length
      ? [...data.areas.map((a) => [a.name, a.router]), [NONE, null]].filter(([n]) => !area || n === area)
      : [[null, null]];
    let shown = 0;
    for (const [name, router] of groups) {
      const list = docs.filter((d) => (name === null ? true : name === NONE ? !d.area : d.area === name));
      if (!list.length && (name === NONE || q || state)) continue;
      shown += list.length;
      body.append(h('section.card.lib-area',
        name !== null && h('div.card-head', icon('docs'), h('h2', name), h('span.meta', plural(list.length, 'document')),
          router && h('a.link', { href: docHref(router), style: 'margin-left:auto' }, router)),
        list.length ? table(list) : h('p.muted', 'No documents in this area yet.')));
    }
    if (!shown && (q || state || area)) body.append(h('p.muted', 'Nothing matches these filters.'));
  }

  function render(d) {
    data = d;
    clear(root);
    const { counts } = d;
    root.append(h('header.page-head', h('div', h('h1', 'Library'),
      h('p.sub', `${plural(d.docs.length, 'document')} · last change from ${d.source === 'git' ? 'git history' : 'file times'} · stale after ${d.thresholds[1]} days`))));
    if (!d.docs.length) { root.append(empty('The Library lists every Markdown file in the repo and how long ago it changed.', 'echo "# Architecture" > docs/architecture.md', ctx)); return; }
    clear(areaSel).append(h('option', { value: '' }, 'Every area'), ...d.areas.map((a) => h('option', { value: a.name }, a.name)), ...(d.areas.length ? [h('option', { value: NONE }, NONE)] : []));
    areaSel.value = area;
    stateSel.value = state;
    areaSel.hidden = !d.areas.length;
    root.append(bar(counts), h('div.filters', search, areaSel, stateSel), body);
    if (!d.areas.length) root.append(h('p.meta', { style: 'margin-top:12px' }, 'Group documents by area: add "areas" to flowrail/config.json, or a table in CLAUDE.md that links one router file per area.'));
    paint();
  }

  const reload = loader(root, () => ctx.api('/library'), render, 6);
  ctx.on(['docs'], reload);
  return () => {};
}
