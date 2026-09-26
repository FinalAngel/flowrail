import { h, icon, loader, relTime, empty } from '../lib/dom.js';

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const state = (a) => {
    const recent = a.lastAt && Date.now() - Date.parse(a.lastAt) < 6 * 3600e3;
    if (a.state === 'running') return h('span.status.ok.working', h('span.dot'), 'Working');
    if (a.state === 'done' && recent) return h('span.status.idle', { style: 'color:var(--text-2)' }, h('span.dot'), `Done ${relTime(a.lastAt)}`);
    return h('span.status.idle', h('span.dot'), 'Idle');
  };
  const render = (d) => {
    const agents = Array.isArray(d) ? d : d?.agents || [];
    const skills = d?.skills || [], commands = d?.commands || [];
    const working = agents.filter((a) => a.state === 'running').length;
    root.append(h('header.page-head', h('div', h('h1', 'Team'), h('p.sub', agents.length ? `${agents.length} agents in .claude/agents${working ? ` · ${working} working` : ''}` : 'Your Claude Code subagents, skills and commands.'))));
    if (!agents.length) root.append(empty('Subagents are Markdown files in .claude/agents. Create one from Claude Code.', 'claude /agents', ctx));
    else root.append(h('div.team-grid.stagger', agents.map((a) => h('article.card.agent',
      h('div.row', h('span.name', a.name), h('span', { style: 'margin-left:auto' }, state(a))),
      h('p.muted', a.description || 'No description.'),
      (a.tools || []).length ? h('div.chips', (Array.isArray(a.tools) ? a.tools : String(a.tools).split(/,\s*/)).map((t) => h('span.chip.mono', t))) : h('div.chips', h('span.chip', 'All tools')),
      h('div.row', a.model && h('span.meta', a.model), a.source && h('a.src', { href: '#/docs?path=' + encodeURIComponent(a.source), style: 'margin-left:auto' }, a.source))))));
    const list = (title, items) => items.length ? [h('h2.section-title', title), h('div.card', { style: 'padding:4px 12px' }, h('ul.list', items.map((s) => h('li', h(s.path ? 'a.item' : 'div.item', s.path ? { href: '#/docs?path=' + encodeURIComponent(s.path) } : {}, icon(title === 'Skills' ? 'file' : 'terminal'), h('span.grow', h('span.t.mono', s.name), s.description && h('span.d', s.description)))))))] : [];
    root.append(...list('Skills', skills), ...list('Commands', commands));
  };
  const reload = loader(root, () => ctx.api('/team'), render, 4);
  ctx.on(['agents'], reload);
  return () => {};
}
