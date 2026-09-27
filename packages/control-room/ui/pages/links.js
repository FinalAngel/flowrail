import { h, icon, loader, empty, shapeIcon } from '../lib/dom.js';

// Bookmarks from flowrail/links.json: web links open in a new tab, repo paths open in Docs.
export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const render = (cats) => {
    cats = Array.isArray(cats) ? cats : [];
    const n = cats.reduce((s, c) => s + c.items.length, 0);
    root.append(h('header.page-head', h('div', h('h1', 'Links'), h('p.sub', n ? `${n} links` : 'The places you and your agents keep going back to.'))));
    if (!n) {
      root.append(empty('Group links by category in flowrail/links.json. Web links open in a new tab; a repo path opens in Docs.',
        `echo '[{"category":"Project","items":[{"title":"Roadmap","url":"docs/roadmap.md"}]}]' > flowrail/links.json`, ctx));
      return;
    }
    for (const c of cats) {
      root.append(h('h2.section-title', c.category), h('div.links-grid.stagger', c.items.map((l) => h('a.card.link-card', {
        href: l.href, ...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      },
      h('span.link-ic', l.shapes ? shapeIcon(l.shapes, 18) : icon(l.icon || (l.external ? 'link' : 'docs'), 18)),
      h('span.grow', h('span.t', l.title, l.external ? h('span.sr-only', ' (opens in a new tab)') : null),
        l.description && h('span.d', l.description),
        h('span.u.mono', l.external ? new URL(l.href).host : l.url)),
      l.external ? icon('external', 14) : icon('chevronRight', 14)))));
    }
  };
  const reload = loader(root, () => ctx.api('/links'), render, 3);
  ctx.on(['docs'], reload);
  return () => {};
}
