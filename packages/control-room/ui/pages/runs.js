import { h, icon, clear, loader, relTime, empty, sheet, skeleton, errorBox, plural } from '../lib/dom.js';

const duration = (r) => {
  if (!r.endedAt) return 'running';
  const s = Math.max(0, Math.round((Date.parse(r.endedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
};
const APPS_EXAMPLE = '"apps": [{ "id": "docs", "name": "Docs site", "cmd": ["npm", "run", "docs"], "url": "http://127.0.0.1:3000" }]';

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);

  function render(d) {
    const list = d.runs || [];
    const failed = list.filter((r) => r.status === 'failed').length;
    root.append(h('header.page-head', h('div', h('h1', 'Runs'),
      h('p.sub', list.length ? `${plural(list.length, 'recorded run')}${failed ? ` · ${failed} failed` : ''}. Headless: they read and report, they do not act.` : 'Headless runs from routines and Run now buttons, with their output.'))));
    root.append(appsSection(d));
    root.append(h('h2.section-title', 'Recent runs'));
    if (!list.length) root.append(empty('A run is a routine or a Run now button working without you. Its output lands here.', 'npx @finalangel/flowrail-room routines run <id>', ctx));
    else root.append(h('div.card', { style: 'padding:4px 0' }, h('div.table-wrap', h('table.tbl.stack-sm',
      h('thead', h('tr', h('th', 'Run'), h('th', 'Started by'), h('th', 'Started'), h('th', 'Took'), h('th', 'Result'))),
      h('tbody', list.map((r) => h('tr', { class: r.status === 'failed' ? 'warn' : '' },
        h('td', h('button.link', { type: 'button', style: 'text-align:left;color:var(--text);font-weight:500', onclick: () => output(r) }, r.title || r.id),
          h('div.meta.mono', { style: 'font-size:12px;overflow-wrap:anywhere' }, r.kind === 'command' ? (r.cmd || []).join(' ') : 'claude -p (read-only tools)')),
        h('td', r.routine ? h('a', { href: '#/routines' }, `Routine ${r.routine}`) : h('span.faint', 'Run now')),
        h('td', relTime(r.startedAt)),
        h('td.num', duration(r)),
        h('td', r.status === 'running' ? h('span.status.ok.working', h('span.dot'), 'Running')
          : r.status === 'failed' ? h('span.status.warn', h('span.dot'), `Failed, exit ${r.exit}`)
            : h('span.status.ok', h('span.dot'), 'OK')))))))));
    root.append(headless(d.headless));
  }

  function appsSection(d) {
    const apps = d.apps || [];
    const wrap = h('section');
    wrap.append(h('h2.section-title', { style: 'margin-top:0' }, 'Applications'));
    if (d.appsError) { wrap.append(h('div.notice.warn', icon('alert'), h('div.body', h('span', d.appsError)))); return wrap; }
    if (!apps.length) {
      wrap.append(h('p.meta', 'Local programs you start from here: a docs site, a slide deck, a preview server. Add them to flowrail/config.json, for example:'),
        h('pre.raw.mono', { style: 'white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px' }, APPS_EXAMPLE));
      return wrap;
    }
    wrap.append(h('div.team-grid.stagger', apps.map((a) => h('article.card.app',
      h('div.row', h('span', { style: 'font-weight:500' }, a.name),
        h('span', { style: 'margin-left:auto' }, a.running
          ? h('span.status.ok', h('span.dot'), a.reachable === false ? 'Starting' : 'Running')
          : h('span.status.idle', h('span.dot'), 'Stopped'))),
      h('p.meta.mono', { style: 'font-size:12px;overflow-wrap:anywhere;margin:6px 0 12px' }, a.cmd.join(' ')),
      h('div.row',
        a.running
          ? h('button.btn.sm', { type: 'button', onclick: (e) => act('stop', a, e.currentTarget) }, 'Stop')
          : h('button.btn.sm.primary', { type: 'button', onclick: (e) => act('start', a, e.currentTarget) }, icon('play', 12), 'Start'),
        a.url && a.running && h('a.btn.sm.ghost', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external', 12), 'Open'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => appLog(a) }, 'Output'))))));
    return wrap;
  }

  function headless(x) {
    if (!x) return '';
    const chips = (list, cls) => h('div.chips', list.map((t) => h('span.chip.mono', { class: cls }, t)));
    return h('details.card', { style: 'margin-top:24px' },
      h('summary', { style: 'cursor:pointer;font-weight:500' }, 'What an unattended run may do'),
      h('p.meta', { style: 'margin:10px 0' }, `Every headless run starts with --permission-mode ${x.permissionMode}: tools outside the allowed list are refused, and your red lines still apply through the hooks.`),
      h('p.label', 'Allowed'), chips(x.allowed, 'accent'),
      h('p.label', { style: 'margin-top:12px' }, 'Always refused'), chips(x.disallowed, 'danger'));
  }

  async function act(action, a, btn) {
    btn.disabled = true;
    try {
      await ctx.api('/apps', { _action: action, id: a.id });
      ctx.toast(action === 'start' ? `${a.name} started` : `${a.name} stopped`);
      reload();
    } catch (e) { ctx.toast(e.message, 'warn'); btn.disabled = false; }
  }

  const logSheet = (title, load) => sheet(title, async (body) => {
    body.append(skeleton(4));
    try {
      const { meta, log } = await load();
      clear(body).append(meta ? h('p.meta', meta) : '', h('pre.raw', { style: 'max-height:60vh;overflow:auto;white-space:pre-wrap' }, log || '(no output yet)'));
    } catch (e) { clear(body).append(errorBox(e)); }
  });
  const output = (r) => logSheet(r.title || r.id, async () => {
    const d = await ctx.api('/runs/' + encodeURIComponent(r.id));
    return { meta: `${r.routine ? `Routine ${r.routine}` : 'Run now'} · started ${relTime(d.startedAt)} · ${duration(d)}${d.exit != null ? ` · exit ${d.exit}` : ''}`, log: d.log };
  });
  const appLog = (a) => logSheet(`${a.name} output`, async () => ({ meta: 'The last 20 KB of .flowrail/apps/' + a.id + '.log', log: (await ctx.api('/apps/log?id=' + encodeURIComponent(a.id))).log }));

  const reload = loader(root, () => ctx.api('/automation'), render, 5);
  ctx.on(['routines'], reload);
  return () => {};
}
