import { h, icon, clear, loader, relTime, empty, confirmBox, shapeIcon, pref, savePref } from '../lib/dom.js';

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  let list = [], kind = pref('artifacts-kind', '');

  const gallery = () => {
    clear(root).append(h('header.page-head', h('div', h('h1', 'Artifacts'), h('p.sub', 'Reports agents leave for you to read.'))));
    if (!list.length) { root.append(empty('Ask an agent to write a self-contained HTML report into flowrail/artifacts/.', 'ls flowrail/artifacts', ctx)); return; }
    // A sidecar's kind (report, brief, ...) filters the gallery; its svg is the card's badge.
    const kinds = [...new Set(list.map((a) => a.kind).filter(Boolean))].sort();
    if (kind && !kinds.includes(kind)) kind = '';
    if (kinds.length) root.append(h('div.toolbar', h('div.filters', h('select.input', { 'aria-label': 'Kind', onchange: (e) => { kind = e.target.value; savePref('artifacts-kind', kind); gallery(); } },
      h('option', { value: '' }, 'Every kind'), kinds.map((k) => h('option', { value: k, selected: k === kind }, k))))));
    const shown = list.filter((a) => !kind || a.kind === kind);
    root.append(h('div.art-grid.stagger', [...shown].sort((a, b) => String(b.created).localeCompare(String(a.created))).map((a) => h('a.card.art', { href: '#/artifacts?name=' + encodeURIComponent(a.name) },
      (a.shapes || a.kind) && h('span.art-top', a.shapes && h('span.art-ic', shapeIcon(a.shapes, 18)), a.kind && h('span.chip', { style: 'height:20px' }, a.kind), a.category && h('span.faint', a.category)),
      h('span.t', a.title || a.name), a.summary && h('span.s', a.summary),
      h('span.m', h('span.mono', a.name), h('span', '·'), h('span', relTime(a.created)), (a.tags || []).map((t) => h('span.chip', { style: 'height:20px' }, t)))))));
  };

  const viewer = (name) => {
    const a = list.find((x) => x.name === name) || { name };
    const src = 'artifacts/' + encodeURIComponent(name);
    document.title = `${a.title || name} · ${ctx.brand}`;
    clear(root).append(
      h('header.page-head', h('div', h('a.link', { href: '#/artifacts' }, '← All artifacts'), h('h1', { style: 'margin-top:6px' }, a.title || name), h('p.sub', h('span.mono', name), a.created ? ` · ${relTime(a.created)}` : '')),
        h('div.actions', h('a.btn', { href: src, target: '_blank', rel: 'noopener' }, icon('external', 14), 'Open in new tab'),
          h('button.btn.danger', { type: 'button', onclick: async () => {
            if (!(await confirmBox(`Move ${name} to .flowrail/trash?`))) return;
            try { await ctx.api('/artifacts', { _action: 'trash', name }); ctx.toast('Moved to trash'); ctx.navigate('#/artifacts'); } catch (e) { ctx.toast(e.message, 'warn'); }
          } }, icon('trash', 14), 'Move to trash'))),
      h('div.frame-wrap', h('iframe', { src, title: a.title || name, sandbox: 'allow-scripts allow-popups', referrerpolicy: 'no-referrer', loading: 'lazy' })));
  };

  const show = (p) => { const n = p.get('name'); n ? viewer(n) : gallery(); };
  const reload = loader(root, () => ctx.api('/artifacts'), (d) => { list = Array.isArray(d) ? d : d?.artifacts || []; show(ctx.params); }, 4);
  ctx.on(['artifacts'], () => { if (!root.querySelector('iframe')) reload(); });
  const un = () => {};
  un.update = (p) => { ctx.params = p; show(p); };
  return un;
}
