import { h, icon, clear, loader, relTime, empty, cmd, sheet, skeleton, errorBox } from '../lib/dom.js';

const DAYS = { monday: 'Mondays', tuesday: 'Tuesdays', wednesday: 'Wednesdays', thursday: 'Thursdays', friday: 'Fridays', saturday: 'Saturdays', sunday: 'Sundays' };
export function scheduleWords(s) {
  if (!s) return 'Manual';
  if (typeof s === 'string') return s;
  const at = s.at || '';
  if (s.every === 'hour') return `Every hour${at ? ` at :${at.split(':')[1] || '00'}` : ''}`;
  if (s.every === 'day') return `Every day ${at}`.trim();
  if (s.every === 'weekday') return `Weekdays ${at}`.trim();
  return `${DAYS[s.every] || s.every} ${at}`.trim();
}

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);

  function render(list) {
    list = Array.isArray(list) ? list : list?.routines || [];
    const installed = list.some((r) => r.installed);
    root.append(h('header.page-head',
      h('div', h('h1', 'Routines'), h('p.sub', 'Scheduled agent runs that report, not act. Defined in flowrail/routines.json.')),
      list.length ? h('div.actions', installed
        ? h('button.btn', { type: 'button', onclick: () => sched('uninstall') }, 'Unschedule all')
        : h('button.btn.primary', { type: 'button', onclick: () => sched('install') }, 'Schedule routines')) : null));
    if (!list.length) { root.append(empty('A routine is a prompt or a command on a schedule, for example a Monday review of the board.', 'npx @flowrail/control-room routines install', ctx)); return; }
    if (!installed) root.append(h('div.notice.warn', { style: 'margin-bottom:16px' }, icon('alert'), h('div.body', h('span', 'Nothing is scheduled yet. flowrail uses launchd on macOS and crontab on Linux.'), cmd('npx @flowrail/control-room routines install', ctx))));
    root.append(h('div.card', { style: 'padding:4px 0' }, h('div.table-wrap', h('table.tbl.stack-sm',
      h('thead', h('tr', h('th', 'Routine'), h('th', 'Schedule'), h('th', 'Last run'), h('th', 'Next'), h('th', h('span.sr-only', 'Actions')))),
      h('tbody', list.map((r) => {
        const failed = r.lastRun && r.lastRun.exit !== 0;
        const first = r.lastRun?.firstLine || r.lastRun?.error || r.lastRun?.message;
        return h('tr', { class: failed ? 'warn' : '' },
          h('td', h('div', { style: 'font-weight:500' }, r.title || r.id), h('div.meta.mono', { style: 'font-size:12px' }, r.run?.type === 'command' ? (r.run.cmd || []).join(' ') : r.id),
            failed && first && h('div.mono', { style: 'font-size:12px;color:var(--warn);margin-top:4px;overflow-wrap:anywhere' }, first)),
          h('td', r.scheduleText || scheduleWords(r.schedule), r.enabled === false && h('div.meta', 'Disabled')),
          h('td', !r.lastRun ? h('span.faint', 'Never') : failed ? h('span.status.warn', h('span.dot'), `Failed, exit ${r.lastRun.exit}`) : h('span.status.ok', h('span.dot'), 'OK'), r.lastRun && h('div.meta', relTime(r.lastRun.at))),
          h('td', r.installed === false ? h('span.faint', 'Not scheduled') : r.next ? relTime(r.next) : '—'),
          h('td', h('div.row', { style: 'justify-content:flex-end;flex-wrap:nowrap' },
            h('button.btn.sm', { type: 'button', onclick: (e) => run(r, e.currentTarget) }, icon('play', 12), 'Run now'),
            h('button.btn.sm.ghost', { type: 'button', onclick: () => output(r) }, 'Output'))));
      }))))));
  }

  async function run(r, btn) {
    btn.disabled = true;
    try { await ctx.api('/routines', { _action: 'run', id: r.id }); ctx.toast(`${r.title || r.id} started. It reports back here.`); }
    catch (e) { ctx.toast(e.message, 'warn'); } finally { btn.disabled = false; }
  }
  async function sched(action) {
    try { await ctx.api('/routines', { _action: action }); ctx.toast(action === 'install' ? 'Routines scheduled' : 'Routines unscheduled'); reload(); }
    catch (e) { ctx.toast(e.message, 'warn'); }
  }
  function output(r) {
    sheet(r.title || r.id, async (body) => {
      body.append(skeleton(4));
      try {
        const runs = await ctx.api('/runs');
        const when = (x) => String(x.startedAt || x.at || x.started || '');
        const mine = (Array.isArray(runs) ? runs : runs?.runs || []).filter((x) => x.routine === r.id || x.id === r.lastRun?.run).sort((a, b) => when(b).localeCompare(when(a)));
        clear(body);
        if (!mine.length) { body.append(h('p.muted', 'No recorded output yet. Run it once to see the log here.')); return; }
        const detail = await ctx.api('/runs/' + encodeURIComponent(mine[0].id)).catch(() => mine[0]);
        body.append(h('p.meta', `Last run ${relTime(when(detail) || when(mine[0]))} · exit ${detail.exit ?? mine[0].exit ?? '?'}`),
          h('pre.raw', { style: 'max-height:60vh;overflow:auto;white-space:pre-wrap' }, detail.log || detail.output || '(empty log)'),
          mine.length > 1 && h('p.meta', `${mine.length - 1} earlier runs in .flowrail/runs`));
      } catch (e) { clear(body).append(errorBox(e)); }
    });
  }

  const reload = loader(root, () => ctx.api('/routines'), render, 4);
  ctx.on(['routines'], reload);
  return () => {};
}
