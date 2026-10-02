import { h, icon, clear, loader, debounce, empty, plural, statbar } from '../lib/dom.js';

// Every skill and slash command Claude Code can use here: the project's, your own, and each enabled plugin's.
const SOURCES = [['project', 'Project', '.claude/skills and .claude/commands, in the repo'], ['user', 'Personal', 'your Claude Code config folder, on this machine']];

export function mount(el, ctx) {
  let data = null;
  let q = '', source = ctx.params.get('source') || '', kind = '';
  const root = h('div');
  el.append(root);
  const body = h('div');

  const search = h('input.input.search', { type: 'search', placeholder: 'Filter by name or description', 'aria-label': 'Filter skills', autocomplete: 'off', oninput: debounce((e) => { q = e.target.value.trim().toLowerCase(); paint(); }, 120) });
  const sourceSel = h('select.input', { 'aria-label': 'Source', onchange: (e) => { source = e.target.value; paint(); } });
  const kindSel = h('select.input', { 'aria-label': 'Kind', onchange: (e) => { kind = e.target.value; paint(); } },
    h('option', { value: '' }, 'Skills and commands'), h('option', { value: 'skill' }, 'Skills'), h('option', { value: 'command' }, 'Commands'));

  const table = (list) => h('div.table-wrap', h('table.tbl',
    h('thead', h('tr', h('th', 'Name'), h('th', 'Kind'), h('th', 'What it is for'))),
    h('tbody', list.map((s) => h('tr',
      h('td.mono', s.path ? h('a', { href: '#/docs?path=' + encodeURIComponent(s.path) }, s.name) : s.name),
      h('td', h('span.chip', s.kind)),
      h('td.muted', s.description || 'No description.'))))));

  // Groups in order: the project, you, then one per plugin.
  const groups = () => [
    ...SOURCES.map(([id, title, note]) => ({ key: id, title, note, list: data.skills.filter((s) => s.source === id) })),
    ...[...new Set(data.skills.filter((s) => s.plugin).map((s) => s.plugin))].map((pl) => ({ key: `plugin:${pl}`, title: pl, note: 'plugin', list: data.skills.filter((s) => s.plugin === pl) })),
  ];

  function paint() {
    if (!data) return;
    clear(body);
    let shown = 0;
    for (const g of groups()) {
      if (source && source !== g.key && !(source === 'plugin' && g.key.startsWith('plugin:'))) continue;
      const list = g.list.filter((s) => (!kind || s.kind === kind) && (!q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)));
      if (!list.length) continue;
      shown += list.length;
      body.append(h('section.card.lib-area',
        h('div.card-head', icon(g.key.startsWith('plugin:') ? 'folder' : 'file'), h('h2', g.title), h('span.meta', `${plural(list.length, 'entry', 'entries')} · ${g.note}`)),
        table(list)));
    }
    if (!shown) body.append(h('p.muted', 'Nothing matches these filters.'));
  }

  function render(d) {
    data = d;
    clear(root);
    const plugins = [...new Set(d.skills.filter((s) => s.plugin).map((s) => s.plugin))];
    root.append(h('header.page-head', h('div', h('h1', 'Skills'),
      h('p.sub', `${plural(d.skills.length, 'skill or command', 'skills and commands')} Claude Code can use here${plugins.length ? `, ${plural(plugins.length, 'plugin')} enabled` : ''}. Type the name after a slash, or let Claude pick one from its description.`))));
    if (!d.skills.length) { root.append(empty('A skill is a folder with a SKILL.md in .claude/skills.', 'mkdir -p .claude/skills/release && printf -- "---\\nname: release\\ndescription: Cut a release.\\n---\\n" > .claude/skills/release/SKILL.md', ctx)); return; }
    clear(sourceSel).append(h('option', { value: '' }, 'Every source'), ...SOURCES.map(([v, l]) => h('option', { value: v }, l)),
      ...(plugins.length ? [h('option', { value: 'plugin' }, 'Every plugin'), ...plugins.map((pl) => h('option', { value: `plugin:${pl}` }, pl))] : []));
    sourceSel.value = source;
    kindSel.value = kind;
    root.append(statbar([
      { label: 'project', n: d.counts.project, tone: 'accent' },
      { label: 'personal', n: d.counts.user, tone: 'warn' },
      { label: 'plugin', n: d.counts.plugin },
    ]), h('div.toolbar', h('div.filters', { role: 'search' }, search, sourceSel, kindSel)), body);
    paint();
  }

  const reload = loader(root, () => ctx.api('/skills'), render, 6);
  ctx.on(['docs'], reload);
  return () => {};
}
