import { h, icon, cmd, relTime, loader, plural, shortDate, clock } from '../lib/dom.js';

const KIND = { 'audit-edited': 'security', 'guard-changed': 'shieldOff', drift: 'shieldOff', hooks: 'shieldOff', audit: 'security', check: 'alert', comment: 'comment', routine: 'routines', task: 'board', redline: 'redlines', 'redlines-changed': 'redlines', artifact: 'artifacts', run: 'terminal', held: 'shield', commit: 'branch', memory: 'memory' };
const DISMISS = 'flowrail-setup-dismissed';
const getDismissed = () => { try { return localStorage.getItem(DISMISS) === '1'; } catch { return false; } };
const setDismissed = (v) => { try { v ? localStorage.setItem(DISMISS, '1') : localStorage.removeItem(DISMISS); } catch { /* ignore */ } };

/**
 * "While you were away": the baseline is when you last looked at the dashboard. Visits closer together than
 * AWAY_GAP count as one sitting, so a reload or a quick trip to the board does not wipe the list.
 * Returns an ISO time, or null on the first visit (the server then shows today).
 */
const SEEN = 'flowrail-dashboard-seen', SINCE = 'flowrail-dashboard-since', AWAY_GAP = 15 * 60e3;
function awayBaseline() {
  try {
    const now = Date.now();
    const seen = Number(localStorage.getItem(SEEN)) || 0;
    let since = Number(localStorage.getItem(SINCE)) || 0;
    if (seen && now - seen > AWAY_GAP) { since = seen; localStorage.setItem(SINCE, String(since)); }
    localStorage.setItem(SEEN, String(now));
    return since ? new Date(since).toISOString() : null;
  } catch { return null; }
}

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const since = awayBaseline();
  // The audit replays transcripts: fetch it once per visit, not on every live refresh.
  const audit = ctx.api('/audit?days=30').catch(() => null);
  const load = async () => {
    const [ov, board, rl, today] = await Promise.all([
      ctx.api('/overview'),
      ctx.api('/board').catch(() => null),
      ctx.api('/redlines').catch(() => null),
      ctx.api('/today' + (since ? '?since=' + encodeURIComponent(since) : '')).catch(() => null),
    ]);
    return { ov, board, rl, today, audit: null, since };
  };
  // The page draws without the audit; its line fills in when the replay is done.
  const fill = () => audit.then((a) => { const line = auditLine(a); const slot = root.querySelector('.audit-slot'); if (line && slot) slot.replaceChildren(line); });
  const reload = loader(root, load, (d) => { render(root, d, ctx, reload); fill(); }, 6);
  ctx.on(null, reload);
  return () => {};
}

function render(root, { ov, board, rl, today, audit, since }, ctx, reload) {
  const c = ov.counts || {};
  const attention = ov.attention || [];
  root.append(
    h('header.page-head',
      h('div', h('h1', greeting()), h('p.sub', summary(c))),
      h('div.actions', h('a.btn', { href: '#/board' }, 'Open board'))),
    h('div.bento',
      h('div.bento-col.stagger', needsYou(attention), today && todayCard(today, since), recentCard(ov.recent || {})),
      h('div.bento-col.stagger', setupCard(ov.setup || {}, reload, ctx), railsCard(rl, ov, ctx, audit), sprintCard(board)),
    ),
  );
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Late night' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}
function summary(c) {
  const bits = [];
  if (c.tasksOpen != null) bits.push(plural(c.tasksOpen, 'open task'));
  if (c.commentsOpen) bits.push(plural(c.commentsOpen, 'comment') + ' waiting');
  if (c.redlinesHeldWeek) bits.push(`red lines held ${c.redlinesHeldWeek}× this week`);
  return bits.join(' · ') || 'Nothing open.';
}

function needsYou(items) {
  const body = items.length
    ? h('ul.list', items.map((a) => h('li', h('a.item', { href: a.href || '#/', class: a.severity === 'warn' || a.severity === 'high' ? 'warn' : '' },
        icon(KIND[a.kind] || 'dot'),
        h('span.grow', h('span.t', a.title), a.detail && h('span.d.mono', a.detail)),
        a.at && h('span.when', relTime(a.at))))))
    : h('div.quiet-line', { style: 'padding:12px 6px' }, icon('check'), 'Nothing needs you right now. Agents work from the board; comments you leave in docs show up here.');
  return h('section.needs.tray', { 'aria-labelledby': 'needs-h' },
    h('div.tray-label', h('h2', { id: 'needs-h', style: 'font-size:13px;font-weight:500' }, 'Needs you'), h('span.count.needs-count', items.length || '')),
    h('div.card', body));
}

/* ---------- Today: what happened in this repo since midnight ---------- */
const WHO = { agent: ['agent', 'Claude'], human: ['user', 'You'] };

function todaySentence(c = {}) {
  const n = (k) => c[k] || 0;
  const parts = [
    n('commentsResolved') && `Claude resolved ${plural(n('commentsResolved'), 'comment')}`,
    n('tasksMoved') && `${plural(n('tasksMoved'), 'task')} moved`,
    n('tasksCreated') && `${plural(n('tasksCreated'), 'task')} filed`,
    n('commits') && `${plural(n('commits'), 'commit')} landed`,
    n('artifacts') && `${plural(n('artifacts'), 'new artifact')}`,
    n('routines') && `${plural(n('routines'), 'routine run')}`,
    n('memories') && `${plural(n('memories'), 'fact')} remembered`,
    n('held') && `${plural(n('held'), 'action')} ${n('held') === 1 ? 'was' : 'were'} held`,
  ].filter(Boolean);
  if (!parts.length) return '';
  const s = parts.length === 1 ? parts[0] : parts.length === 2 ? parts.join(' and ') : `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
  return s[0].toUpperCase() + s.slice(1) + '.';
}

function todayCard(t, since) {
  since ||= t.away || null;
  const items = [...(t.items || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const midnight = new Date().setHours(0, 0, 0, 0);
  const away = since ? Date.parse(since) : 0;
  const line = (it) => {
    const who = WHO[it.by];
    const inner = [
      h('span.tl-time', Date.parse(it.at) < midnight ? shortDate(it.at) : clock(it.at)),
      h('span.tl-kind', { title: it.kind }, icon(KIND[it.kind] || 'dot', 14)),
      h('span.tl-text', h('span.t', it.title), it.detail && h('span.d', ` · ${it.detail}`)),
      who ? h('span.tl-who', { title: who[1], 'aria-label': `by ${who[1]}` }, icon(who[0], 13)) : h('span.tl-who'),
    ];
    const title = [it.title, it.detail].filter(Boolean).join(' · ');
    return h('li', it.href ? h('a.tl-row', { href: it.href, title }, inner) : h('div.tl-row', { title }, inner));
  };
  const sentence = todaySentence(t.counts);
  return h('section.today.card', { 'aria-labelledby': 'today-h' },
    h('div.card-head', icon('dashboard'), h('h2', { id: 'today-h' }, away ? 'While you were away' : 'Today'),
      h('span.meta', { style: 'margin-left:auto', title: away ? new Date(away).toLocaleString() : '' },
        away ? `since ${Date.parse(since) < midnight ? shortDate(since) + ', ' + clock(since) : clock(since)}` : items.length > 0 && plural(items.length, 'event'))),
    items.length
      ? [sentence && h('p.today-sum', sentence), h('ul.timeline', items.slice(0, 30).map(line))]
      : h('p.muted', away ? 'Nothing happened while you were away.' : 'Nothing yet today.'));
}

function setupCard(setup, reload, ctx) {
  const steps = setup.steps || [];
  if (!steps.length) return null;
  const done = steps.filter((s) => s.done).length;
  const dismiss = async (v) => { setDismissed(v); try { await ctx.api('/config', { setupDismissed: v }); } catch { /* local only */ } reload(); };
  if (done === steps.length || setup.dismissed || getDismissed()) {
    return h('section.setup.card', { 'aria-label': 'Setup' }, h('div.quiet-line', icon('check'),
      done === steps.length ? 'Setup complete.' : `Setup hidden, ${done} of ${steps.length} done.`,
      done < steps.length && h('button.link', { type: 'button', style: 'margin-left:auto', onclick: () => dismiss(false) }, 'Show')));
  }
  const firstOpen = steps.findIndex((s) => !s.done);
  return h('section.setup.tray', { 'aria-labelledby': 'setup-h' },
    h('div.tray-label', h('h2', { id: 'setup-h', style: 'font-size:13px;font-weight:500' }, 'Set up flowrail'), h('span.count', `${done} of ${steps.length}`),
      h('button.link', { type: 'button', style: 'margin-left:auto', onclick: () => dismiss(true) }, 'Dismiss')),
    h('div.card',
      h('div.progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': steps.length, 'aria-valuenow': done, 'aria-label': 'Setup progress', style: 'margin-bottom:8px' }, h('span', { style: `transform:scaleX(${done / steps.length})` })),
      h('ol.setup-steps', steps.map((s, i) => h('li', { class: s.done ? 'done' : '' },
        h('span.tick', s.done ? icon('check', 12) : i + 1),
        h('div', h('span.t', s.title), s.done && h('span.sr-only', ' (done)'),
          !s.done && i === firstOpen && s.hint && hint(s.hint, ctx)))))));
}

/** A hint may end in a command ("…, then: npx @finalangel/flowrail-room routines install"): show the prose, then a copyable block. */
function hint(text, ctx) {
  const m = /(?:^|:\s*)((?:npx|flowrail|claude|git)\s.+)$/.exec(text);
  if (!m) return h('p.meta', text);
  const prose = text.slice(0, m.index).replace(/[,:\s]+(?:or\s+)?(?:then|run)?[:\s]*$/i, '').trim();
  return h('div', prose && h('p.meta', prose), cmd(m[1].trim(), ctx));
}

function railsCard(rl, ov, ctx, audit) {
  const events = [...(rl?.events || ov.recent?.redlineEvents || [])].sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const lines = rl?.lines || [];
  const hooks = ctx.hooksState();
  const armed = lines.filter((l) => ctx.isArmed(l, hooks)).length;
  const off = lines.filter((l) => l.state === 'not-enforced' || (!l.state && l.hook && hooks === false)).length;
  const checked = lines.filter((l) => l.state === 'checked').length;
  const held = rl?.stats?.held7d ?? ov.counts?.redlinesHeldWeek ?? 0;
  const last = events[0];
  if (rl && !lines.length) {
    return h('section.rails.card', { 'aria-label': 'Red lines' },
      h('div.card-head', icon('redlines'), h('h2', 'Rails')),
      h('p.muted', 'No red lines yet. Write down the one rule an agent must never break.'),
      h('a.btn.sm', { href: '#/redlines', style: 'margin-top:12px' }, 'Add a red line'));
  }
  return h('section.rails.card', { 'aria-label': 'Red lines' },
    h('a.rails-strip', { href: '#/redlines' },
      h('span.rails-glyph', { class: off ? 'off' : '' }, icon(off ? 'shieldOff' : 'shield', 18)),
      h('div.grow', { style: 'flex:1;min-width:0' },
        h('div', { style: 'font-weight:500' }, [off ? `${off} not enforced` : `${armed} armed`, checked && `${checked} checked in CI`].filter(Boolean).join(' · '), h('span.faint', ` · held ${held}× this week`)),
        h('div.meta.one-line', { title: last?.subject || '' }, last ? [`${relTime(last.at)} · `, h('span.mono', last.subject || last.path || '')] : 'Nothing held yet this week.'),
        h('div.audit-slot', auditLine(audit))),
      icon('chevronRight')));
}

/** One line from the transcript replay: what the current rules would have caught in the last 30 days. */
function auditLine(a) {
  if (!a?.calls) return null;
  const n = (a.held?.length || 0) + (a.asked?.length || 0);
  return h('div.meta.audit-line', n
    ? `Last ${a.days} days: would have caught ${n} of ${new Intl.NumberFormat().format(a.calls)} tool calls`
    : `Last ${a.days} days: ${new Intl.NumberFormat().format(a.calls)} tool calls, none crossed a red line`);
}

function sprintCard(board) {
  if (!board) return h('section.sprint.card', h('div.card-head', icon('board'), h('h2', 'Sprint')), h('p.muted', 'Board unavailable.'));
  const cur = board.config?.current;
  const inSprint = (board.tasks || []).filter((t) => t.sprint && (!cur || t.sprint === cur.start));
  const done = inSprint.filter((t) => t.status === 'Done').length;
  const prog = inSprint.filter((t) => t.status === 'In Progress').length;
  const rev = inSprint.filter((t) => t.status === 'Review').length;
  const pct = inSprint.length ? done / inSprint.length : 0;
  return h('section.sprint.card', { 'aria-labelledby': 'sprint-h' },
    h('div.card-head', icon('board'), h('h2', { id: 'sprint-h' }, cur?.label || 'Sprint'), cur && h('span.meta', { style: 'margin-left:auto' }, `${shortDate(cur.start)} to ${shortDate(cur.end)}`)),
    h('div.stat', done, h('small', ` / ${inSprint.length} done`)),
    h('div.progress', { role: 'progressbar', 'aria-label': 'Sprint progress', 'aria-valuemin': 0, 'aria-valuemax': inSprint.length, 'aria-valuenow': done, style: 'margin-top:10px' }, h('span', { style: `transform:scaleX(${pct})` })),
    h('div.kv', h('div', h('span.k', 'In progress'), h('span.v', prog)), h('div', h('span.k', 'Review'), h('span.v', rev)), h('div', h('span.k', 'Backlog'), h('span.v', (board.tasks || []).filter((t) => !t.sprint).length))));
}

function recentCard(recent) {
  const arts = recent.artifacts || [];
  return h('section.recent.card', { 'aria-labelledby': 'recent-h' },
    h('div.card-head', icon('artifacts'), h('h2', { id: 'recent-h' }, 'Recent artifacts'), h('a.link', { href: '#/artifacts', style: 'margin-left:auto' }, 'All')),
    arts.length
      ? h('ul.list', arts.slice(0, 5).map((a) => h('li', h('a.item', { href: '#/artifacts?name=' + encodeURIComponent(a.name) },
          icon('file'), h('span.grow', h('span.t', a.title || a.name), a.summary && h('span.d', a.summary)), h('span.when', relTime(a.created))))))
      : h('p.muted', 'Reports agents write to flowrail/artifacts/ appear here.'));
}

