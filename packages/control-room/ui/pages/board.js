import { h, icon, clear, loader, relTime, shortDate, sheet, confirmBox, empty, debounce, busy, pref, savePref, append, statbar } from '../lib/dom.js';

const parseDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
const localDay = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const COLS = ['Backlog', 'Todo', 'In Progress', 'Review', 'Done'];
const PRIOS = ['P0', 'P1', 'P2', 'P3'];
// A store (a plugin's board) can bring its own priorities, groups and source file; see src/core/board.js.

export function mount(el, ctx) {
  let data = null, gh = null, agents = new Set(['claude']);
  // Filters come back after a reload (per browser); the search box never does.
  const f = { q: '', who: pref('board-who', ''), group: pref('board-group', ''), done: pref('board-done', false), agentOnly: pref('board-agent', false), github: pref('board-github', true) };
  const setF = (k, v) => { f[k] = v; savePref(`board-${k === 'agentOnly' ? 'agent' : k}`, v); paint(); };
  const prios = () => data?.config?.priorities || PRIOS;
  const rank = (p) => { const i = prios().indexOf(p); return i < 0 ? 9 : i; };
  const groups = () => data?.config?.groups || [];
  const groupChip = (name) => { const g = groups().find((x) => x.name === name); return name ? h('span.chip.group', { style: `height:20px;${g?.color ? `--g:${g.color}` : ''}` }, name) : null; };
  const source = () => data?.config?.source || 'flowrail/board.json';
  // One sprint at a time: the Backlog column plus the tasks of the sprint shown (the current one by default).
  let shown = null;
  // Board (one sprint in columns) or Backlog (every open task in one table): the Backlog page mounts
  // this module with ctx.mode = 'backlog'; an old #/board?view=backlog link still opens it too.
  let view = ctx.mode === 'backlog' || ctx.params.get('view') === 'backlog' ? 'backlog' : 'board';
  const backlogEl = h('div.card.backlog', { style: 'padding:4px 0' });
  const sprintLabel = (start) => (sprintList().find((x) => x.start === start)?.label) || start;
  const sprintList = () => data?.config?.sprints || (data?.config?.current ? [data.config.current] : []);
  const shownSprint = () => sprintList().find((x) => x.start === shown) || data?.config?.current || null;
  const inView = (t) => !t.sprint || !shownSprint() || t.sprint === shownSprint().start;
  const root = h('div');
  el.append(root);

  ctx.api('/team').then((t) => { for (const a of (Array.isArray(t) ? t : t?.agents || [])) agents.add(a.name); if (data) paint(); }).catch(() => {});

  const colOf = (t) => (!t.sprint ? 'Backlog' : COLS.includes(t.status) ? t.status : 'Todo');
  const isAgent = (name) => !!name && (agents.has(name) || /\b(agent|claude|bot)\b/i.test(name));

  async function move(t, col) {
    if (colOf(t) === col) return;
    const patch = col === 'Backlog' ? { sprint: '' } : { status: col, sprint: t.sprint || shownSprint()?.start || '' };
    const before = { status: t.status, sprint: t.sprint };
    Object.assign(t, patch); paint();
    try {
      await ctx.api('/board', { _action: 'update', id: t.id, ...patch });
      ctx.toast(`${t.id} moved to ${col}`);
    } catch (e) {
      Object.assign(t, before); paint();
      ctx.toast(`Could not move ${t.id}. ${e.message}`, 'warn');
    }
  }

  function moveMenu(t, anchor) {
    document.querySelector('.popover')?.remove();
    const cur = colOf(t);
    const close = () => { pop.remove(); document.removeEventListener('pointerdown', outside, true); anchor.focus(); };
    const outside = (e) => { if (!pop.contains(e.target)) close(); };
    const pop = h('div.popover', { role: 'menu', 'aria-label': `Move ${t.id} to`, onkeydown: (e) => {
      const btns = [...pop.querySelectorAll('button')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    } },
      h('div.label', 'Move to…'),
      COLS.map((c) => h('button', { type: 'button', role: 'menuitem', 'aria-current': c === cur ? 'true' : null, onclick: () => { close(); move(t, c); } }, c === cur ? icon('check') : h('span', { style: 'width:16px' }), c)));
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = 200, hgt = pop.offsetHeight;
    pop.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.right - w)) + 'px';
    pop.style.top = (r.bottom + hgt + 8 > innerHeight ? Math.max(8, r.top - hgt - 4) : r.bottom + 4) + 'px';
    pop.querySelector('button:not([aria-current])')?.focus();
    setTimeout(() => document.addEventListener('pointerdown', outside, true));
  }

  function card(t) {
    const agent = isAgent(t.assignee);
    const c = h('article.tcard', { draggable: 'true', dataset: { id: t.id }, 'aria-roledescription': 'task card',
      ondragstart: (e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; c.classList.add('dragging'); },
      ondragend: () => c.classList.remove('dragging'),
      onkeydown: (e) => {
        if (!e.altKey || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
        e.preventDefault();
        const i = COLS.indexOf(colOf(t)) + (e.key === 'ArrowRight' ? 1 : -1);
        if (i >= 0 && i < COLS.length) move(t, COLS[i]).then(() => root.querySelector(`[data-id="${t.id}"] .title`)?.focus());
      } },
      h('div.top', h('span.id', t.id), h('span.prio', { class: `p${rank(t.priority)}`, title: `Priority ${t.priority}` }, t.priority),
        h('button.icon-btn.menu-trigger', { type: 'button', 'aria-label': `Move ${t.id} to…`, 'aria-haspopup': 'menu', onclick: (e) => { e.stopPropagation(); moveMenu(t, e.currentTarget); } }, icon('more'))),
      h('button.title', { type: 'button', 'aria-keyshortcuts': 'Alt+ArrowLeft Alt+ArrowRight', 'aria-description': 'Alt plus arrow keys move the card between columns', onclick: () => detail(t) }, t.title),
      h('div.foot',
        t.assignee ? h('span.who', { title: agent ? 'Agent' : 'Person' }, icon(agent ? 'agent' : 'user', 13), t.assignee) : h('span.faint', 'Unassigned'),
        groupChip(t.group),
        (t.labels || []).slice(0, 2).map((l) => h('span.chip.mono', { style: 'height:20px' }, l)),
        t.createdBy === 'agent' && h('span.chip', { style: 'height:20px', title: 'Filed by agent' }, 'Filed by agent'),
        t.notes?.length ? h('span.faint', { title: 'Notes' }, icon('comment', 12)) : null));
    return c;
  }

  // A GitHub issue: read-only, opens on GitHub, never dragged or written back.
  const issueCard = (i) => h('a.tcard.issue', { href: i.url, target: '_blank', rel: 'noopener noreferrer', 'aria-label': `GitHub issue #${i.number}: ${i.title} (opens GitHub)` },
    h('div.top', h('span.id', `#${i.number}`), h('span.chip', { style: 'height:20px' }, icon('branch', 12), 'GitHub'), i.state === 'CLOSED' && h('span.faint', { style: 'margin-left:auto' }, 'closed')),
    h('span.title', i.title),
    h('div.foot', (i.assignees || []).slice(0, 1).map((a) => h('span.who', icon('user', 13), a)), (i.labels || []).slice(0, 2).map((l) => h('span.chip.mono', { style: 'height:20px' }, l))));
  const issuesIn = (col) => {
    if (!f.github || !gh?.available || (col !== 'Todo' && col !== 'Done')) return [];
    const q = f.q.toLowerCase();
    return gh.issues.filter((i) => (col === 'Done') === (i.state === 'CLOSED') && (!q || `#${i.number} ${i.title} ${(i.labels || []).join(' ')}`.toLowerCase().includes(q)));
  };

  function column(name, tasks) {
    const issues = issuesIn(name);
    const body = h('div.col-body', tasks.map(card), issues.map(issueCard));
    const col = h('section.col', { 'aria-label': `${name}, ${tasks.length} tasks`,
      ondragover: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; col.classList.add('drop'); },
      ondragleave: (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop'); },
      ondrop: (e) => { e.preventDefault(); col.classList.remove('drop'); const t = data.tasks.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (t) move(t, name); } },
      h('header.col-head', h('h2', { style: 'font-size:13px;font-weight:500' }, name), h('span.count', tasks.length + issues.length),
        name === 'Backlog' || name === 'Todo' ? h('button.icon-btn', { type: 'button', style: 'margin-left:auto;width:28px;height:28px', 'aria-label': `New task in ${name}`, onclick: () => create(name) }, icon('plus')) : null),
      body);
    return col;
  }

  const boardEl = h('div.board');
  const filterRow = h('div.filters', { role: 'search' });
  // The page's one-line summary lives in the header's middle; the Backlog adds a status bar.
  const summaryEl = h('span.top-summary');
  const statEl = h('div');
  function paint() {
    if (view === 'backlog') return paintBacklog();
    const q = f.q.toLowerCase();
    const tasks = data.tasks.filter((t) => inView(t) && (!q || `${t.id} ${t.title} ${(t.labels || []).join(' ')}`.toLowerCase().includes(q))
      && (!f.who || (f.who === '(none)' ? !t.assignee : t.assignee === f.who)) && (!f.group || t.group === f.group) && (!f.agentOnly || t.createdBy === 'agent'));
    const order = (a, b) => rank(a.priority) - rank(b.priority) || (b.updated || '').localeCompare(a.updated || '');
    clear(boardEl).append(...COLS.map((c) => column(c, tasks.filter((t) => colOf(t) === c).sort(order))));
    summaryEl.textContent = sub();
    const nav = root.querySelector('.sprint-nav');
    if (nav) nav.replaceWith(sprintNav());
  }
  // Every task not done, from every sprint and the unscheduled backlog, highest priority first.
  function paintBacklog() {
    const q = f.q.toLowerCase();
    const rows = data.tasks.filter((t) => (f.done || t.status !== 'Done') && (!q || `${t.id} ${t.title} ${(t.labels || []).join(' ')}`.toLowerCase().includes(q))
      && (!f.who || (f.who === '(none)' ? !t.assignee : t.assignee === f.who)) && (!f.group || t.group === f.group) && (!f.agentOnly || t.createdBy === 'agent'))
      .sort((a, b) => rank(a.priority) - rank(b.priority) || (a.sprint || '9999').localeCompare(b.sprint || '9999') || String(a.id).localeCompare(String(b.id)));
    const hasGroups = groups().length > 0;
    clear(backlogEl).append(rows.length ? h('div.table-wrap', h('table.tbl',
      h('thead', h('tr', h('th', 'Task'), hasGroups && h('th', 'Group'), h('th', 'Priority'), h('th', 'Sprint'), h('th', 'Status'), h('th', 'Assignee'), h('th', 'Updated'))),
      h('tbody', rows.map((t) => h('tr.row-link', { tabindex: '0', onclick: () => detail(t), onkeydown: (e) => { if (e.key === 'Enter') detail(t); } },
        h('td', h('span.mono.faint', { style: 'margin-right:8px' }, t.id), t.title),
        hasGroups && h('td', groupChip(t.group)),
        h('td', h('span.prio', { class: `p${rank(t.priority)}` }, t.priority)),
        h('td', t.sprint ? sprintLabel(t.sprint) : h('span.faint', 'Backlog')),
        h('td', t.status),
        h('td', t.assignee || h('span.faint', 'Unassigned')),
        h('td.meta', relTime(t.updated))))))) : h('p.meta', { style: 'padding:16px' }, 'Nothing open matches.'));
    summaryEl.textContent = `${rows.length} ${f.done ? 'tasks' : 'open tasks'} across every sprint and the backlog`;
    const count = (st) => rows.filter((t) => t.status === st).length;
    statEl.replaceChildren(statbar([
      { label: 'to do', n: count('Todo'), tone: 'muted' },
      { label: 'in progress', n: count('In Progress'), tone: 'info' },
      { label: 'in review', n: count('Review'), tone: 'warn' },
      ...(f.done ? [{ label: 'done', n: count('Done'), tone: 'accent' }] : []),
      { label: 'not in a sprint', n: rows.filter((t) => !t.sprint).length, bar: false },
    ]));
  }



  const sub = () => {
    const cur = shownSprint();
    const inSprint = data.tasks.filter((t) => t.sprint && inView(t));
    const n = inSprint.length, d = inSprint.filter((t) => t.status === 'Done').length;
    return cur ? `${cur.label || 'Current sprint'} · ${shortDate(cur.start)} to ${shortDate(cur.end)} · ${d} of ${n} done` : `${d} of ${n} done`;
  };

  function sprintNav() {
    const list = sprintList();
    const i = list.findIndex((x) => x.start === shownSprint()?.start);
    const go = (j) => { shown = list[j].start; paint(); };
    const cur = data.config?.current?.start;
    // Days left in the running sprint, counting today; shown only while the current sprint is on screen.
    const isCur = shownSprint()?.start === cur;
    const left = isCur && data.config?.current?.end ? Math.round((parseDate(data.config.current.end) - parseDate(localDay())) / 86400000) + 1 : null;
    return h('div.sprint-nav', { role: 'group', 'aria-label': 'Sprint' },
      left !== null && h('span.days-left', left <= 1 ? 'Last day' : `${left} days left`),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Previous sprint', disabled: i <= 0, onclick: () => go(i - 1) }, icon('chevronLeft')),
      h('span.sprint-label', shownSprint()?.label || 'Sprint', shownSprint()?.start === cur ? h('span.chip.accent', { style: 'height:20px;margin-left:8px' }, 'current') : null),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Next sprint', disabled: i < 0 || i >= list.length - 1, onclick: () => go(i + 1) }, icon('chevronRight')),
      shownSprint()?.start !== cur && h('button.btn.sm.ghost', { type: 'button', onclick: () => { shown = cur; paint(); } }, 'This sprint'));
  }

  function filters() {
    const people = [...new Set(data.tasks.map((t) => t.assignee).filter(Boolean))].sort();
    if (f.who && f.who !== '(none)' && !people.includes(f.who)) f.who = '';
    const search = h('input.input.search', { type: 'search', placeholder: 'Filter tasks', 'aria-label': 'Filter tasks', value: f.q, oninput: debounce((e) => { f.q = e.target.value; paint(); }, 80) });
    append(clear(filterRow), [search,
      h('select.input', { 'aria-label': 'Assignee', onchange: (e) => setF('who', e.target.value) },
        h('option', { value: '' }, 'Anyone'), people.map((p) => h('option', { value: p, selected: f.who === p }, p)), h('option', { value: '(none)', selected: f.who === '(none)' }, 'Unassigned')),
      groups().length > 0 && h('select.input', { 'aria-label': 'Group', onchange: (e) => setF('group', e.target.value) },
        h('option', { value: '' }, 'Every group'), groups().map((g) => h('option', { value: g.name, selected: f.group === g.name }, g.name))),
      view === 'backlog' && h('label.switch', h('input', { type: 'checkbox', checked: f.done, onchange: (e) => setF('done', e.target.checked) }), 'Show done'),
      h('label.switch', h('input', { type: 'checkbox', checked: f.agentOnly, onchange: (e) => setF('agentOnly', e.target.checked) }), 'Filed by agent'),
      gh?.configured && h('label.switch', { title: `Open issues assigned in ${gh.repo}, and those closed this sprint. Read-only.` }, h('input', { type: 'checkbox', checked: f.github, onchange: (e) => setF('github', e.target.checked) }), 'GitHub issues'),
      gh?.configured && !gh.available && h('span.chip.warn', { title: 'The gh CLI is missing, signed out or offline. Your tasks are unaffected.' }, icon('alert', 12), 'GitHub unavailable'),
      gh?.configured && gh.available && f.github && h('button.icon-btn', { type: 'button', 'aria-label': 'Refresh GitHub issues', title: 'Refresh GitHub issues', onclick: (e) => busy(e.currentTarget, loadIssues(true)) }, icon('refresh'))]);
  }
  const loadIssues = (refresh) => ctx.api('/board/issues' + (refresh ? '?refresh=1' : ''))
    .then((r) => { gh = r; }, () => { gh = null; })
    .then(() => { if (data?.tasks.length && filterRow.isConnected) { filters(); paint(); } });

  function renderAll(d) {
    data = d;
    if (!data.tasks.length) {
      root.append(h('header.page-head', h('div', h('h1', 'Board')), h('div.actions', h('button.btn.primary', { type: 'button', onclick: () => create('Todo') }, icon('plus'), 'New task'))),
        empty(`The board is ${source()}. You and your agents file tasks into it.`, 'npx @finalangel/flowrail-room task "Write the first test" --priority P2', ctx));
      return;
    }
    renderShell();
    const focusId = ctx.params.get('task');
    if (focusId) { const t = data.tasks.find((x) => x.id === focusId); if (t) detail(t); }
  }

  function renderShell() {
    filters();
    clear(root).append(...[
      h('header.page-head', h('div', h('h1', view === 'board' ? 'Board' : 'Backlog'))),
      view === 'backlog' && statEl,
      h('div.toolbar', filterRow, h('div.toolbar-actions', view === 'board' && sprintNav(),
        h('button.btn.primary', { type: 'button', onclick: () => create(view === 'backlog' ? 'Backlog' : 'Todo') }, icon('plus'), 'New task'))),
      view === 'board' ? boardEl : backlogEl].filter(Boolean));
    ctx.header?.({ summary: summaryEl });
    paint();
  }

  function create(col) {
    sheet('New task', (body, close) => {
      const title = h('input.input', { id: 'nt-title', required: true, placeholder: 'What needs doing', autocomplete: 'off' });
      const mid = prios()[Math.floor((prios().length - 1) / 2) + (prios().length > 3 ? 1 : 0)];
      const prio = h('select.input', { id: 'nt-prio' }, prios().map((p) => h('option', { value: p, selected: p === mid }, p)));
      const grp = groups().length ? h('select.input', { id: 'nt-group' }, groups().map((g) => h('option', { value: g.name, selected: g.name === f.group }, g.name))) : null;
      const who = h('input.input', { id: 'nt-who', placeholder: 'you, claude, reviewer…', autocomplete: 'off' });
      const where = h('select.input', { id: 'nt-where' }, h('option', { value: 'current', selected: col !== 'Backlog' }, 'This sprint'), h('option', { value: 'backlog', selected: col === 'Backlog' }, 'Backlog'));
      const err = h('p.err', { role: 'alert' });
      body.append(h('form', { class: 'stack', onsubmit: async (e) => {
        e.preventDefault();
        if (!title.value.trim()) { title.setAttribute('aria-invalid', 'true'); err.textContent = 'Give the task a title.'; title.focus(); return; }
        await busy(e.submitter, ctx.api('/board', { _action: 'create', title: title.value.trim(), priority: prio.value, ...(grp ? { group: grp.value } : {}), assignee: who.value.trim(), status: col === 'Backlog' ? 'Todo' : col, sprint: where.value === 'backlog' ? '' : shownSprint()?.start || 'current' })
          .then((t) => { ctx.toast(`Filed ${t?.id || 'task'}`); close(); reload(); }, (x) => { err.textContent = x.message; }));
      } },
        h('div.field', h('label', { for: 'nt-title' }, 'Title'), title),
        h('div.form-grid', h('div.field', h('label', { for: 'nt-prio' }, 'Priority'), prio), h('div.field', h('label', { for: 'nt-where' }, 'Sprint'), where),
          grp && h('div.field', h('label', { for: 'nt-group' }, 'Group'), grp),
          h('div.field.full', h('label', { for: 'nt-who' }, 'Assignee'), who)),
        err,
        h('div.row.end', h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'File task'))));
      title.focus();
    });
  }

  function detail(t) {
    sheet(t.id, (body, close) => {
      const save = async (patch) => {
        try { await ctx.api('/board', { _action: 'update', id: t.id, ...patch }); Object.assign(t, patch); paint(); ctx.toast('Saved'); }
        catch (e) { ctx.toast(`Not saved. ${e.message}`, 'warn'); }
      };
      const noteIn = h('textarea.input', { id: 'td-note', rows: 3, placeholder: 'Add a note agents will read' });
      const notes = h('ol.notes', (t.notes || []).map((n) => h('li', h('div.by', `${n.by || 'someone'} · ${relTime(n.at)}`), h('div', n.text))));
      body.append(
        h('h3', { style: 'font-size:18px;line-height:1.35;overflow-wrap:anywhere' }, t.title),
        h('div.row', t.createdBy === 'agent' && h('span.chip', icon('agent', 12), 'Filed by agent'), groupChip(t.group), (t.labels || []).map((l) => h('span.chip.mono', l)), h('span.meta', `updated ${relTime(t.updated)}`)),
        h('div.form-grid',
          h('div.field', h('label', { for: 'td-col' }, 'Column'), h('select.input', { id: 'td-col', onchange: (e) => move(t, e.target.value) }, COLS.map((c) => h('option', { value: c, selected: colOf(t) === c }, c)))),
          h('div.field', h('label', { for: 'td-prio' }, 'Priority'), h('select.input', { id: 'td-prio', onchange: (e) => save({ priority: e.target.value }) }, prios().map((p) => h('option', { value: p, selected: t.priority === p }, p)))),
          groups().length > 0 && h('div.field', h('label', { for: 'td-group' }, 'Group'), h('select.input', { id: 'td-group', onchange: (e) => save({ group: e.target.value }) }, groups().map((g) => h('option', { value: g.name, selected: t.group === g.name }, g.name)))),
          h('div.field.full', h('label', { for: 'td-who' }, 'Assignee'), h('input.input', { id: 'td-who', value: t.assignee || '', onchange: (e) => save({ assignee: e.target.value.trim() }) })),
          'description' in t && h('div.field.full', h('label', { for: 'td-desc' }, 'Description'), h('textarea.input', { id: 'td-desc', rows: 4, onchange: (e) => save({ description: e.target.value }) }, t.description || ''))),
        h('div', h('div.label', { style: 'margin-bottom:8px' }, 'Notes'), (t.notes || []).length ? notes : h('p.meta', 'No notes yet.')),
        h('form.stack', { onsubmit: async (e) => {
          e.preventDefault();
          const text = noteIn.value.trim(); if (!text) return;
          try { await busy(e.submitter, ctx.api('/board', { _action: 'note', id: t.id, text })); (t.notes ||= []).push({ at: new Date().toISOString(), by: 'you', text }); notes.append(h('li', h('div.by', 'you · just now'), h('div', text))); noteIn.value = ''; if (!notes.isConnected) { close(); detail(t); } }
          catch (x) { ctx.toast(x.message, 'warn'); }
        } }, h('label.sr-only', { for: 'td-note' }, 'Note'), noteIn, h('div.row.end', h('button.btn.sm', { type: 'submit' }, 'Add note'))),
        h('hr.sep'),
        h('div.row', h('button.btn.sm.danger', { type: 'button', onclick: async () => {
          if (!(await confirmBox(`Move ${t.id} to the trash? You can restore it from there.`))) return;
          try { await ctx.api('/board', { _action: 'trash', id: t.id }); close(); ctx.toast(`${t.id} moved to trash`); reload(); } catch (e) { ctx.toast(e.message, 'warn'); }
        } }, icon('trash'), 'Move to trash'), h('span.meta.mono', { style: 'margin-left:auto' }, source())));
    });
  }

  const reload = loader(root, () => ctx.api('/board'), renderAll, 5);
  loadIssues(false);
  ctx.on(['board'], () => { if (!document.querySelector('dialog[open], .popover')) reload(); });
  const unmount = () => document.querySelector('.popover')?.remove();
  unmount.update = (params) => { const id = params.get('task'); const t = id && data?.tasks.find((x) => x.id === id); if (t) detail(t); };
  return unmount;
}
