import { h, icon, loader, empty } from '../lib/dom.js';
import { inline } from '../lib/markdown.js';

const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const render = (list) => {
    list = Array.isArray(list) ? list : list?.workflows || [];
    root.append(h('header.page-head', h('div', h('h1', 'Workflows'), h('p.sub', 'Markdown playbooks in flowrail/workflows. A step marked GATE or SIGN-OFF waits for you.'))));
    if (!list.length) { root.append(empty('A workflow is a Markdown file with “## Step 1: …” headings.', 'mkdir -p flowrail/workflows && printf "# Release\\n\\n## Step 1: Draft changelog\\n\\n## Step 2: SIGN-OFF: review\\n" > flowrail/workflows/release.md', ctx)); return; }
    root.append(h('div.wf-grid.stagger', list.map((w) => {
      const gates = w.steps.filter((s) => s.gate).length;
      return h('article.card', { 'aria-label': w.title },
        h('div.card-head', icon('workflows'), h('h2', w.title), h('a.link', { href: '#/docs?path=' + encodeURIComponent(w.file), style: 'margin-left:auto' }, 'Open')),
        h('p.meta', { style: 'margin:-6px 0 14px' }, `${w.steps.length} steps`, gates ? ` · ${gates} sign-off${gates > 1 ? 's' : ''}` : ''),
        h('ol.steps', w.steps.map((s) => h('li', { class: s.gate ? 'gate' : '' },
          h('span.n', { 'aria-hidden': 'true' }, h('span', s.n)),
          h('div', h('div.st', s.gate ? h('span.sr-only', 'Sign-off gate: ') : null, cap(s.title.replace(/^(GATE|SIGN-OFF)\s*:?\s*/i, '')), s.gate && h('span.chip', { style: 'margin-left:8px;height:20px' }, 'Sign-off')),
            s.body && sbody(s.body))))));
    })));
  };
  const sbody = (text) => { const d = h('div.sb'); d.innerHTML = inline(text.split('\n').find((l) => l.trim()) || ''); return d; }; // inline() escapes everything
  const reload = loader(root, () => ctx.api('/workflows'), render, 4);
  ctx.on(['docs'], reload);
  return () => {};
}
