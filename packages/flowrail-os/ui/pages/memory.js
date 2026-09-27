import { h, icon, clear, loader, debounce, skeleton, errorBox, empty, shortDate, sheet, busy, pref, savePref } from '../lib/dom.js';
import { renderMarkdown, inline } from '../lib/markdown.js';

// The renderer escapes every piece of source text; only its fixed tags reach the page.
const md = (tag, html) => { const el = h(tag); el.innerHTML = html; return el; };

const TYPES = ['user', 'feedback', 'project', 'reference'];
const norm = (s) => String(s || '').replace(/[`*_.,;:\s]+/g, ' ').trim().toLowerCase();
/** The body without a first paragraph that only repeats the card's title. */
const bodyOf = (m) => {
  const [first, ...rest] = String(m.body || '').trim().split(/\n\s*\n/);
  return norm(first) === norm(m.description) ? rest.join('\n\n') : String(m.body || '');
};

export function mount(el, ctx) {
  let items = [], tab = pref('memory-type', 'all'), q = ctx.params.get('q') || '', only = ctx.params.get('name') || '', seq = 0;
  const input = h('input', { type: 'search', placeholder: 'Ask your memory…', 'aria-label': 'Ask your memory', value: q, autocomplete: 'off' });
  const results = h('div');
  const browse = h('div');
  el.append(
    h('header.page-head', h('div', h('h1', 'Memory'), h('p.sub', 'Facts your agents recall before they guess. Plain Markdown, ranked without a model.'))),
    // The question and the button to add a fact share one row.
    h('div.toolbar.mem-bar',
      h('form.recall', { role: 'search', onsubmit: (e) => { e.preventDefault(); recall(); } }, icon('search', 18), input),
      h('div.toolbar-actions', h('button.btn', { type: 'button', onclick: add }, icon('plus'), 'Remember something'))),
    h('div', { style: 'margin-top:24px' }, results),
    browse);

  const card = (m) => h('article.card.mem',
    md('p.fact', inline(String(m.description || m.snippet || m.name || ''))),
    bodyOf(m) && md('div.body.prose', renderMarkdown(bodyOf(m), { base: m.path || 'flowrail/memory/' })),
    h('div.m', h('span.chip', m.type || m.source || 'memory'), m.path !== null && h('span.p', m.path || `flowrail/memory/${m.name}.md`), m.created && h('span', shortDate(m.created)), m.score != null && h('span.num', { title: 'Recall score' }, `score ${(+m.score).toFixed(2).replace(/\.00$/, '')}`)));

  async function recall() {
    const my = ++seq;
    q = input.value.trim();
    history.replaceState(null, '', '#/memory' + (q ? '?q=' + encodeURIComponent(q) : ''));
    if (!q) { clear(results); browse.hidden = false; return; }
    browse.hidden = true;
    clear(results).append(skeleton(3));
    try {
      const r = await ctx.api('/recall?q=' + encodeURIComponent(q));
      if (my !== seq) return;
      const hits = r?.hits || [];
      const byName = new Map(items.map((m) => [m.name, m]));
      clear(results).append(
        h('div.row', { style: 'margin-bottom:12px' }, h('h2', { style: 'font-size:13px;font-weight:500;color:var(--text-2)' }, hits.length ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}` : 'Nothing recalled'), h('button.link', { type: 'button', style: 'margin-left:auto', onclick: () => { input.value = ''; recall(); } }, 'Clear')),
        hits.length
          ? h('div.mem-grid.stagger', hits.map((x) => card({ ...(byName.get(x.name) || {}), ...x, description: byName.get(x.name)?.description || x.title || x.snippet, body: byName.get(x.name) ? byName.get(x.name).body : x.snippet })))
          : h('p.muted', `No memory mentions “${q}”. Try other words, or store it with npx @finalangel/flowrail-os remember.`));
    } catch (e) { if (my === seq) clear(results).append(errorBox(e, recall)); }
  }
  input.addEventListener('input', debounce(recall, 220));

  function paintBrowse() {
    clear(browse);
    if (!items.length) { browse.append(empty('Nothing remembered yet. Agents store facts with one command, and recall them before they guess.', 'npx @finalangel/flowrail-os remember "Releases go out on Tuesdays" --type project --name release-day', ctx)); return; }
    const counts = Object.fromEntries(TYPES.map((t) => [t, items.filter((m) => m.type === t).length]));
    const pick = only && items.filter((m) => m.name === only);
    if (pick?.length) { browse.append(h('div.row', { style: 'margin-bottom:12px' }, h('span.meta.mono', only), h('button.link', { type: 'button', style: 'margin-left:auto', onclick: () => { only = ''; history.replaceState(null, '', '#/memory'); paintBrowse(); } }, 'Show all')), h('div.mem-grid', pick.map(card))); return; }
    if (tab !== 'all' && !TYPES.includes(tab)) tab = 'all';
    const list = tab === 'all' ? items : items.filter((m) => m.type === tab);
    browse.append(
      h('div.seg', { role: 'tablist', 'aria-label': 'Browse by type', style: 'margin-bottom:16px' },
        ['all', ...TYPES].map((t) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(tab === t), onclick: () => { tab = t; savePref('memory-type', t); paintBrowse(); } }, t === 'all' ? `All ${items.length}` : `${t[0].toUpperCase() + t.slice(1)} ${counts[t]}`))),
      list.length ? h('div.mem-grid', { role: 'tabpanel' }, [...list].sort((a, b) => String(b.created).localeCompare(String(a.created))).map(card)) : h('p.muted', 'None of this type yet.'));
  }

  function add() {
    sheet('Remember something', (body, close) => {
      const fact = h('input.input', { id: 'm-fact', placeholder: 'Releases go out on Tuesdays' });
      const type = h('select.input', { id: 'm-type' }, TYPES.map((t) => h('option', { value: t, selected: t === 'project' }, t)));
      const name = h('input.input.mono', { id: 'm-name', placeholder: 'release-day' });
      const more = h('textarea.input', { id: 'm-body', rows: 4, placeholder: 'Why it holds, how to apply it' });
      const err = h('p.err', { role: 'alert' });
      fact.addEventListener('input', () => { name.value = fact.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').split('-').slice(0, 4).join('-'); });
      body.append(h('form.stack', { onsubmit: async (e) => {
        e.preventDefault();
        if (!fact.value.trim() || !name.value.trim()) { err.textContent = 'A fact and a name are both needed.'; return; }
        await busy(e.submitter, ctx.api('/memory', { _action: 'store', name: name.value.trim(), type: type.value, description: fact.value.trim(), body: more.value.trim() })
          .then(() => { ctx.toast('Remembered'); close(); reload(); }, (x) => { err.textContent = x.status === 409 ? 'A memory with that name exists. Pick another name.' : x.message; }));
      } },
        h('div.field', h('label', { for: 'm-fact' }, 'Fact'), fact),
        h('div.form-grid', h('div.field', h('label', { for: 'm-type' }, 'Type'), type), h('div.field', h('label', { for: 'm-name' }, 'Name'), name)),
        h('div.field', h('label', { for: 'm-body' }, 'Details (optional)'), more),
        err, h('div.row.end', h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Remember'))));
      fact.focus();
    });
  }

  const reload = loader(browse, () => ctx.api('/memory'), (d) => { items = d?.items || (Array.isArray(d) ? d : []); paintBrowse(); if (q) recall(); }, 4);
  ctx.on(['memory'], reload);
  const un = () => {};
  un.update = (p) => { const nn = p.get('name') || ''; if (nn !== only) { only = nn; paintBrowse(); } const nq = p.get('q') || ''; if (nq !== input.value) { input.value = nq; recall(); } };
  return un;
}
