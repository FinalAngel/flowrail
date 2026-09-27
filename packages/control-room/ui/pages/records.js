// Records: one configured folder of Markdown files as a table (#/records/<id>) or a board grouped by
// its status field (#/records/<id>/board). Same layout as Backlog and Board: summary in the header,
// one toolbar row, then the table or the columns.
import { h, icon, clear, loader, empty, debounce, pref, savePref, statbar, shortDate } from '../lib/dom.js';

const docHref = (p) => '#/docs?path=' + encodeURIComponent(p);
const DAY = 86400000;
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
/** Days from today to an ISO date (negative when past). */
const daysTo = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Math.round((new Date(y, m - 1, d) - today()) / DAY); };

/** The due chip: overdue and the next three days carry a word and a tone; later dates stay quiet. */
export function dueOf(iso) {
  if (!iso) return null;
  const n = daysTo(iso);
  if (n < 0) return { cls: 'over', tone: 'danger', text: `overdue ${-n}d` };
  if (n === 0) return { cls: 'soon', tone: 'warn', text: 'due today' };
  if (n === 1) return { cls: 'soon', tone: 'warn', text: 'due tomorrow' };
  if (n <= 3) return { cls: 'soon', tone: 'warn', text: `due in ${n}d` };
  return { cls: '', tone: '', text: `due ${shortDate(iso)}` };
}

export function mount(el, ctx) {
  const m = /^#\/records\/([a-z0-9-]+)(\/board)?/.exec(location.hash) || [];
  const id = m[1], boardView = !!m[2];
  const key = (k) => `rec-${id}-${k}`;
  const root = h('div');
  el.append(root);
  let col = null, recs = [], q = '';
  const f = { status: boardView ? '' : pref(key('status'), ''), due: pref(key('due'), false), sort: pref(key('sort'), 'title'), dir: pref(key('dir'), 1) };
  const picks = {};
  const summary = h('span');
  const body = h('div');
  const stat = h('div');
  ctx.header?.({ summary });

  const shown = () => recs.filter((r) => (!q || `${r.title} ${r.name} ${Object.values(r.fields).join(' ')}`.toLowerCase().includes(q))
    && (!f.status || r.status === f.status)
    && col.filters.every((k) => !picks[k] || r.fields[k] === picks[k])
    && (!f.due || (r.due && daysTo(r.due) <= 3)));
  const toneOf = (v) => col.status.tones[v] || 'muted';

  function toolbar() {
    const sel = (label, value, options, onchange) => h('select.input', { 'aria-label': label, onchange: (e) => onchange(e.target.value) },
      h('option', { value: '' }, label), options.map((o) => h('option', { value: o, selected: o === value }, o)));
    const values = (k) => [...new Set(recs.map((r) => r.fields[k]).filter(Boolean))].sort();
    return h('div.toolbar', h('div.filters', { role: 'search' },
      h('input.input.search', { type: 'search', placeholder: `Filter ${col.title.toLowerCase()}`, 'aria-label': 'Filter', value: q, oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 100) }),
      !boardView && sel('Every status', f.status, col.status.values, (v) => { f.status = v; savePref(key('status'), v); paint(); }),
      col.filters.map((k) => sel(`Every ${k.replace(/[_-]+/g, ' ')}`, picks[k], values(k), (v) => { picks[k] = v; savePref(key(`f-${k}`), v); paint(); })),
      col.due && h('label.switch', h('input', { type: 'checkbox', checked: f.due, onchange: (e) => { f.due = e.target.checked; savePref(key('due'), f.due); paint(); } }), 'Due soon')));
  }

  function dueCell(r) {
    const d = dueOf(r.due);
    return d ? h('span', { class: d.tone ? `chip ${d.tone}` : 'meta', style: d.tone ? 'height:20px' : '' }, d.text) : '';
  }

  function table(rows) {
    const words = (k) => { const t = k.replace(/[_-]+/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
    const cols = [['title', 'Record'], ['status', words(col.status.field)], ...col.columns.map((c) => [c, words(c)]), ...(col.due ? [['due', 'Due']] : [])];
    const val = (r, k) => (k === 'title' ? r.title : k === 'status' ? r.status : k === 'due' ? r.due || '' : r.fields[k] || '');
    const sorted = [...rows].sort((a, b) => String(val(a, f.sort)).localeCompare(String(val(b, f.sort)), undefined, { numeric: true }) * f.dir || a.name.localeCompare(b.name));
    const th = ([k, label]) => h('th', { 'aria-sort': f.sort === k ? (f.dir > 0 ? 'ascending' : 'descending') : null },
      h('button.th-sort', { type: 'button', onclick: () => { f.dir = f.sort === k ? -f.dir : 1; f.sort = k; savePref(key('sort'), k); savePref(key('dir'), f.dir); paint(); } }, label, f.sort === k ? (f.dir > 0 ? ' ↑' : ' ↓') : ''));
    return h('div.card.backlog', { style: 'padding:4px 0' }, rows.length ? h('div.table-wrap', h('table.tbl',
      h('thead', h('tr', cols.map(th))),
      h('tbody', sorted.map((r) => h('tr.row-link', { tabindex: '0', onclick: () => ctx.navigate(docHref(r.path)), onkeydown: (e) => { if (e.key === 'Enter') ctx.navigate(docHref(r.path)); } },
        cols.map(([k]) => h('td', k === 'status' ? h('span', { class: `tone-${toneOf(r.status)}` }, r.status || '—') : k === 'due' ? dueCell(r) : k === 'title' ? h('span', { style: 'font-weight:500' }, r.title) : val(r, k)))))))) : h('p.meta', { style: 'padding:16px' }, 'Nothing matches.'));
  }

  async function move(r, to, btn) {
    btn.disabled = true;
    try {
      const res = await ctx.api(`/records/${id}`, { _action: 'move', path: r.path, status: to, mtime: r.mtime });
      Object.assign(r, { status: to, mtime: res.mtime });
      r.fields[col.status.field] = to;
      ctx.toast(`${r.title} moved to ${to}`);
      paint();
    } catch (e) { ctx.toast(e.message, 'warn'); btn.disabled = false; }
  }

  function card(r) {
    const d = dueOf(r.due);
    const order = col.status.board;
    const i = order.indexOf(r.status);
    return h('article.tcard.rcard', { class: d?.cls ? `due-${d.cls}` : '' },
      h('div.top', h('a.title', { href: docHref(r.path) }, r.title),
        h('span.rmove', h('button.icon-btn', { type: 'button', 'aria-label': `Move ${r.title} to ${order[i - 1] || ''}`, disabled: i <= 0, onclick: (e) => move(r, order[i - 1], e.currentTarget) }, icon('chevronLeft', 14)),
          h('button.icon-btn', { type: 'button', 'aria-label': `Move ${r.title} to ${order[i + 1] || ''}`, disabled: i < 0 || i >= order.length - 1, onclick: (e) => move(r, order[i + 1], e.currentTarget) }, icon('chevronRight', 14)))),
      col.columns.slice(0, 2).some((c) => r.fields[c]) && h('div.rfields', col.columns.slice(0, 2).map((c) => r.fields[c] && h('span', r.fields[c]))),
      d && h('div.foot', dueCell(r)));
  }

  function board(rows) {
    return h('div.board.rboard', { style: `--cols:${col.status.board.length}` },
      col.status.board.map((v) => {
        const list = rows.filter((r) => r.status === v).sort((a, b) => (a.due || '9999').localeCompare(b.due || '9999') || a.title.localeCompare(b.title));
        return h('section.col', { 'aria-label': `${v}, ${list.length}` },
          h('header.col-head', h('span', { class: `tone-${toneOf(v)}` }, h('span.dot')), h('h2', { style: 'font-size:13px;font-weight:500' }, v), h('span.count', list.length)),
          h('div.col-body', list.map(card)));
      }));
  }

  function paint() {
    const rows = shown();
    const count = (v) => rows.filter((r) => r.status === v).length;
    const inBoard = rows.filter((r) => col.status.board.includes(r.status));
    summary.textContent = boardView
      ? `${inBoard.length} on the board · ${col.status.board.map((v) => `${count(v)} ${v}`).join(' · ')}`
      : `${rows.length} of ${recs.length} ${col.title.toLowerCase()}`;
    stat.replaceChildren(boardView ? '' : statbar(col.status.values.map((v) => ({ label: v, n: count(v), tone: toneOf(v) }))));
    clear(body).append(boardView ? board(rows) : table(rows));
  }

  async function load() {
    const [cfg, data] = await Promise.all([ctx.api('/records'), ctx.api(`/records/${id}`)]);
    return { col: (cfg.collections || []).find((c) => c.id === id), data };
  }
  const reload = loader(root, load, ({ col: c, data }) => {
    col = c;
    if (!col) { root.append(empty('No records collection with this address. Collections live in flowrail/config.json under "records".', 'cat flowrail/config.json', ctx)); return; }
    recs = data.records || [];
    for (const k of col.filters) picks[k] = pref(key(`f-${k}`), '');
    root.append(h('header.page-head', h('div', h('h1', boardView ? `${col.title} board` : col.title))));
    if (!recs.length) { root.append(empty(`${col.title} are Markdown files in ${col.dir}/, one per record, with the fields in frontmatter.`, `mkdir -p ${col.dir} && printf -- "---\\ntitle: First record\\n${col.status.field}: ${col.status.values[0] || 'new'}\\n---\\n" > ${col.dir}/first.md`, ctx)); return; }
    root.append(stat, toolbar(), body);
    paint();
  }, 6);
  ctx.on(['docs'], () => { if (!document.querySelector('dialog[open]')) reload(); });
  return () => {};
}
