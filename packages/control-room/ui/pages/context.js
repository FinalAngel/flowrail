import { h, icon, loader, empty, shortDate, plural } from '../lib/dom.js';

// The context library: one folder per source (a book, a course, a standard), each with index.md.
const docHref = (p) => '#/docs?path=' + encodeURIComponent(p);

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const render = (d) => {
    const entries = d?.entries || [];
    root.append(h('header.page-head', h('div', h('h1', 'Context'),
      h('p.sub', entries.length ? `${plural(entries.length, 'source')} in ${d.dir}` : `Reference material your agents read before they answer, in ${d?.dir || 'flowrail/context'}.`))));
    if (d?.error) root.append(h('p.muted', d.error));
    if (!entries.length) {
      root.append(empty('One folder per source: an index.md with a title, where it came from and a summary, plus any notes next to it.',
        `mkdir -p ${d?.dir || 'flowrail/context'}/style-guide && printf -- "---\\ntitle: House style guide\\nsource: https://example.com/style\\nsummary: How we write docs\\n---\\n" > ${d?.dir || 'flowrail/context'}/style-guide/index.md`, ctx));
      return;
    }
    root.append(h('div.card', { style: 'padding:4px 0' }, h('div.table-wrap', h('table.tbl.ctx-tbl',
      h('thead', h('tr', h('th', 'Source'), h('th.ctx-sum', 'Summary'), h('th', 'Notes'), h('th.fig', 'Updated'))),
      h('tbody', entries.map((e) => h('tr',
        h('td', h('a.lib-title', { href: docHref(e.path) }, e.title), h('div.meta.mono', e.slug),
          e.source && (/^https?:\/\//i.test(e.source)
            ? h('a.meta.ctx-src', { href: e.source, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 12), new URL(e.source).hostname)
            : h('div.meta', e.source))),
        h('td.ctx-sum', e.summary || h('span.faint', 'No summary')),
        h('td', e.docs.length ? h('ul.ctx-docs', e.docs.map((p) => h('li', h('a', { href: docHref(p) }, p.split('/').pop())))) : h('span.faint', 'None')),
        h('td.fig', e.changed ? shortDate(e.changed) : ''))))))));
  };
  const reload = loader(root, () => ctx.api('/context'), render, 4);
  ctx.on(['docs'], reload);
  return () => {};
}
