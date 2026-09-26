import { h, icon, clear, loader, cmd, clock, day, sheet, confirmBox, debounce, empty, plural, relTime } from '../lib/dom.js';

const SEV = { block: 'Blocks', ask: 'Asks first', warn: 'Warns' };
const HELD = { block: 'held, not run', ask: 'held, agent asked instead', warn: 'allowed with a warning' };
const WOULD = { block: 'would have held', ask: 'would have asked first', warn: 'would have warned' };
const num = (n) => new Intl.NumberFormat().format(n);
const WEAKEN = 'To weaken a rule, edit flowrail/red-lines.json yourself. Claude will be asked first.';

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  let data;

  // The server's state wins (src/core/redlines.js stateOf); the fallback mirrors it.
  const stateOf = (l, hooks) => ({ armed: 'armed', checked: 'checked', declared: 'declared', 'not-enforced': 'off' })[l.state]
    || ((l.hook?.match || l.hook?.builtin) ? (hooks === false ? 'off' : 'armed') : l.check?.pattern ? 'checked' : 'declared');

  function render(d) {
    data = d;
    const lines = d.lines || [];
    const own = d.hooks && typeof d.hooks === 'object' && 'installed' in d.hooks ? d.hooks : null;
    const hi = own || ctx.hooksInfo() ? { ...ctx.hooksInfo(), ...own } : null;
    const hooks = hi ? !!(hi.installed && (hi.healthy ?? true) && hi.guard?.verified !== false) : typeof d.hooksInstalled === 'boolean' ? d.hooksInstalled : ctx.hooksState();
    const changed = hi?.guard?.verified === false ? hi.guard.changed || [] : null;
    const count = (s) => lines.filter((l) => stateOf(l, hooks) === s).length;
    const byId = d.stats?.byId || {};
    const held = d.stats?.held7d ?? (d.events || []).length;

    const sub = lines.length
      ? [['armed', 'armed'], ['off', 'not enforced'], ['checked', 'checked in CI'], ['declared', 'declared only']]
        .map(([s, label]) => count(s) && `${count(s)} ${label}`).concat(`held ${held}× this week`).filter(Boolean).join(' · ')
      : 'Rules an agent cannot skip. The guard checks every tool call against them.';
    root.append(h('header.page-head', h('div', h('h1', 'Red lines'), h('p.sub', sub)),
      h('div.actions',
        h('button.btn', { type: 'button', onclick: (e) => verify(e.currentTarget) }, icon('check'), 'Verify'),
        h('a.btn', { href: '#/docs?path=' + encodeURIComponent('flowrail/red-lines.json') }, 'Open red-lines.json'),
        h('button.btn.primary', { type: 'button', onclick: () => edit() }, icon('plus'), 'Add red line'))));

    if (hooks === false) {
      root.append(h('div.notice.danger', { style: 'margin-bottom:16px' }, icon('shieldOff'), h('div.body',
        h('strong', changed ? 'Not enforced. The guard files in this repo no longer match the version flowrail installed.'
          : hi?.installed ? 'Not enforced. The guard is installed but does not run, so these rules are only text an agent may or may not follow.'
            : 'Not enforced. The guard is not installed, so these rules are only text an agent may or may not follow.'),
        changed?.length > 0 && h('span.muted.mono', { style: 'overflow-wrap:anywhere' }, changed.join(', ')),
        !changed && hi?.problem && h('span.muted', hi.problem),
        h('span.muted', changed || hi?.installed ? 'Restore the guard from the package. It rewrites only .claude/flowrail/guard/ and the hook entries.' : 'Install the guard. It shows the plan and asks before changing settings.'),
        cmd(changed || hi?.installed ? 'npx flowrail upgrade' : 'npx flowrail guard init', ctx))));
    }
    if (d.drift?.changed) {
      root.append(h('div.notice.danger', { style: 'margin-bottom:16px' }, icon('shieldOff'), h('div.body',
        h('strong', 'Rules changed outside flowrail. Review and accept in a terminal: npx flowrail redlines accept'),
        d.drift.files?.length > 0 && h('span.muted.mono', { style: 'overflow-wrap:anywhere' }, d.drift.files.join(', ')),
        h('span.muted', 'Until then the guard asks before every tool call. The command shows the diff against the last accepted rules.'),
        cmd('npx flowrail redlines accept', ctx))));
    }
    root.append(verifyBox);
    root.append(auditPanel());

    const rules = h('div.rules.stagger');
    if (!lines.length) {
      rules.append(empty('Write the one rule an agent must never break, for example “never push without asking”.', 'npx flowrail redlines', ctx,
        h('button.btn.primary.sm', { type: 'button', onclick: () => edit() }, 'Add your first red line')));
    }
    for (const l of lines) rules.append(ruleCard(l, stateOf(l, hooks), byId[l.id] || 0));

    root.append(h('div.rl-grid',
      h('div', { style: 'min-width:0' }, rules),
      h('div.side-stack', tester(), holdsLog(d.events || []), checks(d), headless(d.headless))));
  }

  function ruleCard(l, state, n) {
    const badge = state === 'armed' ? h('span.state.armed', icon('shield', 14), 'Armed')
      : state === 'off' ? h('span.state.off', icon('shieldOff', 14), 'Not enforced')
        : state === 'checked' ? h('span.state.checked', { title: 'Enforced in CI by flowrail check, not at runtime' }, icon('check', 14), 'Checked in CI')
          : h('span.state.declared', icon('alert', 14), 'Declared only');
    const builtin = l.hook?.builtin || l.builtin;
    const glob = l.params?.glob;
    const hookMatch = l.hook ? (builtin ? `built-in ${builtin}${glob ? ` on ${glob}` : ''}` : l.hook.match) : null;
    const summary = (l.summary && l.summary !== l.title ? l.summary : '') || l.why;
    const detail = (k, v) => h('div.dl', h('span.k', k), h('code.code-box', v));
    return h('article.card.rule', { 'aria-label': l.title },
      h('div.headline', h('p.quote', l.title), badge),
      l.floor && h('p.builtin-note', icon('lock', 14), h('span', h('strong', 'Built in. '), 'Part of the guard itself, so it cannot be removed. You can make it stricter.')),
      summary && h('p.why', summary),
      h('div.foot',
        h('span.chip', SEV[l.severity] || l.severity),
        h('span.num', n ? `Held ${n}× this week` : 'Not triggered this week'),
        h('span.spacer'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => edit(l), 'aria-label': `Edit ${l.id}` }, icon('edit', 14), h('span.lbl', 'Edit'))),
      h('div.chain', { class: state === 'armed' ? 'armed' : '', role: 'list', 'aria-label': 'Rule, check, hook' },
        h('span.node', { role: 'listitem' }, h('span.k', 'Rule'), l.id),
        h('span.link-rail', { 'aria-hidden': 'true' }),
        l.check
          ? h('span.node', { role: 'listitem' }, h('span.k', 'Check'), l.check.glob || '**/*')
          : h('button.node.optional', { type: 'button', role: 'listitem', onclick: () => edit(l) }, icon('plus', 12), 'Add a check'),
        h('span.link-rail', { 'aria-hidden': 'true' }),
        l.hook
          ? h('span.node', { role: 'listitem' }, h('span.k', 'Hook'), builtin ? `${l.hook.tool || '*'} · ${builtin}${glob ? ' ' + glob : ''}` : (l.hook.tool || '*'))
          : h(state === 'checked' ? 'button.node.optional' : 'button.node.missing', { type: 'button', role: 'listitem', onclick: () => edit(l) }, icon('plus', 12), 'Add a hook')),
      (l.hook || l.check || (l.why && l.why !== summary)) && h('details.rule-details',
        h('summary', icon('chevronRight', 14), 'Details'),
        h('div.dl-list',
          l.why && l.why !== summary && detail('Why', l.why),
          glob && detail('Protects', glob),
          l.hook && detail(`Hook · ${l.hook.tool || '*'}`, hookMatch),
          l.check && detail(`Check · ${l.check.glob || '**/*'}`, l.check.pattern),
          l.check?.message && detail('Check reports', l.check.message))));
  }

  /* ---------- Verify: the guard's probes for every rule, commands it must hold and ones it must allow ---------- */
  const verifyBox = h('div', { 'aria-live': 'polite' });
  const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null && o[k] !== '') return o[k]; return ''; };
  async function verify(btn) {
    btn.disabled = true;
    clear(verifyBox).append(h('div.skeleton', { 'aria-busy': 'true', 'aria-label': 'Verifying' }, h('div.sk-row', { style: '--w:60%' })));
    try { clear(verifyBox).append(probeTable(await ctx.api('/redlines', { _action: 'verify' }))); }
    catch (e) { clear(verifyBox).append(h('div.notice.warn', { style: 'margin-bottom:16px' }, icon('alert'), h('div.body', h('span', e.message)))); }
    finally { btn.disabled = false; }
  }
  function probeTable(r) {
    // verifyRedlines: { lines: [{ id, positive: [{ probe, decision, ok }], negative: [...] }], skipped }
    const rows = Array.isArray(r) ? r : (r?.lines || []).flatMap((l) => [
      ...(l.positive || []).map((x) => ({ ...x, id: l.id, expect: 'held' })),
      ...(l.negative || []).map((x) => ({ ...x, id: l.id, expect: 'allowed' }))]);
    const okOf = (x) => x.ok ?? x.pass ?? x.passed ?? (pick(x, 'got', 'actual', 'decision') === pick(x, 'expect', 'expected'));
    const failed = rows.filter((x) => !okOf(x)).length;
    const rules = new Set(rows.map((x) => pick(x, 'id', 'line', 'rule'))).size;
    const summary = r?.summary || `${failed ? `${failed} of ${rows.length} probes failed` : `Verified: ${rules} ${rules === 1 ? 'rule' : 'rules'}, ${rows.length} probes`}${failed ? '' : ', all as expected'}.${r?.skipped?.length ? ` Not probed: ${r.skipped.map((s) => s.id).join(', ')}.` : ''}`;
    return h('section.card', { style: 'margin-bottom:16px', 'aria-labelledby': 'verify-h' },
      h('div.card-head', h('h2', { id: 'verify-h' }, 'Verify'), h('span.spacer'),
        h('button.btn.sm.ghost', { type: 'button', onclick: () => clear(verifyBox), 'aria-label': 'Close verify results' }, icon('x', 14))),
      h('p', { class: failed ? 'status danger' : 'status ok', style: 'margin-bottom:10px' }, icon(failed ? 'alert' : 'check', 14), summary),
      rows.length > 0 && h('p.meta', { style: 'margin-bottom:10px' }, 'held = dangerous examples stopped; allowed = harmless examples let through. In Got, deny never runs and ask means Claude Code asks you first.'),
      rows.length > 0 && h('div.probe-wrap', h('table.probes',
        h('thead', h('tr', ['Rule', 'Probe', 'Expected', 'Got'].map((t) => h('th', { scope: 'col' }, t)))),
        h('tbody', rows.map((x) => h('tr', { class: okOf(x) ? '' : 'fail' },
          h('td.mono', pick(x, 'id', 'line', 'rule')),
          h('td.mono', [pick(x, 'tool') && pick(x, 'tool') !== 'Bash' ? `${x.tool} ` : '', pick(x, 'probe', 'subject', 'command', 'input')].join('')),
          h('td', pick(x, 'expect', 'expected')),
          h('td', h('span', { class: okOf(x) ? 'ok' : 'bad' }, pick(x, 'got', 'actual', 'decision')))))))));
  }

  /* ---------- What these rules would have caught: replay of recent Claude Code transcripts ---------- */
  let auditDays = 30;
  const auditCache = {};
  function auditPanel() {
    const box = h('div', { 'aria-live': 'polite' });
    const seg = h('div.seg', { role: 'group', 'aria-label': 'Period' }, [7, 30, 90].map((n) => h('button', { type: 'button', 'aria-pressed': String(n === auditDays), onclick: () => { auditDays = n; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === `${n} days`))); paint(); } }, `${n} days`)));
    const paint = async () => {
      const n = auditDays;
      if (!auditCache[n]) clear(box).append(h('div.skeleton', { 'aria-busy': 'true', 'aria-label': 'Loading' }, h('div.sk-row', { style: '--w:72%' }), h('div.sk-row', { style: '--w:54%' })));
      try {
        const a = auditCache[n] || (auditCache[n] = await ctx.api('/audit?days=' + n));
        if (n === auditDays && box.isConnected) clear(box).append(auditBody(a));
      } catch (e) {
        if (n !== auditDays || !box.isConnected) return;
        clear(box).append(e.status === 404 ? h('p.meta', 'This flowrail version cannot replay transcripts yet. Update it, then run ', h('span.mono', 'npx flowrail audit'), '.') : h('p.meta', e.message));
      }
    };
    paint();
    return h('section.card.audit', { 'aria-labelledby': 'audit-h' },
      h('div.card-head', h('h2', { id: 'audit-h' }, 'What these rules would have caught'), h('span.spacer'), seg),
      box);
  }
  function auditBody(a) {
    const held = a.held || [], asked = a.asked || [];
    const range = `Last ${a.days} days`;
    if (!a.calls) {
      return h('div.stack',
        h('p.meta', a.note || `No Claude Code sessions for this project in the last ${a.days} days.`),
        a.transcriptsDir && !(a.note || '').includes(a.transcriptsDir) && h('p.meta', 'Looked in ', h('span.mono', { style: 'overflow-wrap:anywhere' }, a.transcriptsDir)),
        h('p.meta', 'Replays are read-only and local. Nothing leaves this machine.'));
    }
    const top = Object.entries(a.byLine || {}).sort((x, y) => y[1] - x[1]).slice(0, 3);
    const lead = `${range}: ${num(a.calls)} tool ${a.calls === 1 ? 'call' : 'calls'} in ${plural(a.sessions, 'session')}.`;
    const found = held.length + asked.length;
    const sentence = !found ? ' None of them crosses a red line.'
      : ` These rules would have held ${held.length}${asked.length ? ` and asked first on ${asked.length}` : ''}.`;
    const items = [...held.map((x) => ({ ...x, v: x.severity })), ...asked.map((x) => ({ ...x, v: 'ask' }))]
      .sort((x, y) => String(y.at).localeCompare(String(x.at)));
    return h('div.stack',
      h('p.audit-sum', a.demo && h('span.chip', { style: 'margin-right:8px' }, 'Demo transcripts'), h('span', lead), h('strong', sentence),
        top.length > 1 && h('span.meta', ` Most often ${top.map(([id, n]) => `${id} (${n})`).join(', ')}.`)),
      items.length > 0 && h('ul.audit-list', items.slice(0, 5).map((x) => h('li',
        h('span.audit-glyph', { class: x.v === 'block' ? 'block' : '' }, icon('shield', 14)),
        h('div', { style: 'min-width:0' },
          h('div.s.mono', x.subject || x.tool),
          h('div.o', [WOULD[x.v] || 'would have held', x.line, x.tool !== 'Bash' && x.tool, relTime(x.at)].filter(Boolean).join(' · ')))))),
      items.length > 5 && h('p.meta', `And ${items.length - 5} more. The full list: `, h('span.mono', `npx flowrail audit --days ${a.days}`)),
      h('p.meta.faint', a.demo ? 'Replayed from the demo transcripts that came with this example workspace, not your own sessions. Nothing ran.'
        : 'Replayed from your local Claude Code transcripts. Nothing ran and nothing left this machine.'));
  }

  function tester() {
    const tool = h('select.input', { id: 'try-tool', 'aria-label': 'Tool', style: 'width:auto' }, ['Bash', 'Write', 'Edit'].map((t) => h('option', { value: t }, t)));
    const input = h('input.input.mono', { id: 'try-cmd', placeholder: 'git push origin main', autocomplete: 'off', spellcheck: 'false' });
    const out = h('div.decision', { 'aria-live': 'polite' }, h('span.muted', 'Type a command or a file path to see what the guard decides.'));
    let seq = 0;
    const run = debounce(async () => {
      const subject = input.value.trim();
      const my = ++seq;
      if (!subject) { out.className = 'decision'; clear(out).append(h('span.muted', 'Type a command or a file path to see what the guard decides.')); return; }
      try {
        const r = await ctx.api('/redlines', { _action: 'test', tool: tool.value, subject });
        if (my !== seq) return;
        const decision = r?.decision || r?.permissionDecision || r?.hookSpecificOutput?.permissionDecision || (r?.systemMessage ? 'warn' : 'allow');
        const id = r?.id || r?.line?.id;
        const seen = (r?.normalized || []).join('  ;  ');
        const line = (data.lines || []).find((l) => l.id === id);
        if (decision === 'deny' || decision === 'block') { out.className = 'decision held'; clear(out).append(icon('shield'), h('div', h('strong', 'Held. '), 'The agent is stopped and told why.', h('div.meta.mono', id || ''), line && h('div.meta', `“${line.title}”`))); }
        else if (decision === 'ask') { out.className = 'decision held'; clear(out).append(icon('shield'), h('div', h('strong', 'Held. '), 'The agent has to ask you first.', h('div.meta.mono', id || ''), line && h('div.meta', `“${line.title}”`))); }
        else if (decision === 'warn') { out.className = 'decision warned'; clear(out).append(icon('alert'), h('div', h('strong', 'Allowed with a warning. '), h('div.meta.mono', id || r?.systemMessage || ''))); }
        else { out.className = 'decision'; clear(out).append(icon('check'), h('div', h('strong', 'Allowed. '), 'No red line matches.')); }
        if (seen && seen !== subject) out.lastChild.append(h('div.meta', 'Read as ', h('span.mono', seen)));
      } catch (e) { if (my === seq) { out.className = 'decision'; clear(out).append(h('span', e.message)); } }
    }, 180);
    input.addEventListener('input', run); tool.addEventListener('change', run);
    const pre = ctx.params.get('try'); // #/redlines?try=git%20push links straight to a decision
    if (pre) { input.value = pre; run(); }
    return h('section.card.tester', { 'aria-labelledby': 'try-h' },
      h('div.card-head', h('h2', { id: 'try-h' }, 'Try it')),
      h('div.row', { style: 'flex-wrap:nowrap' }, tool, h('label.sr-only', { for: 'try-cmd' }, 'Command or path'), input),
      h('div', { style: 'margin-top:10px' }, out),
      h('p.meta', { style: 'margin-top:8px' }, 'Same decision the guard makes. Nothing runs.'));
  }

  function holdsLog(events) {
    const list = h('ul.log');
    let lastDay = '';
    for (const e of [...events].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30)) {
      const d = day(e.at);
      if (d !== lastDay) { lastDay = d; list.append(h('li.day', d)); }
      const subj = e.subject || e.path || '';
      list.append(h('li', h('span.t', clock(e.at)), h('div', { style: 'min-width:0;flex:1' },
        h('div.s', { title: subj }, subj),
        h('div.o', { title: e.path || '' }, HELD[e.severity] || 'held', e.id ? ` · ${e.id}` : '', e.path && e.path !== subj ? ` · ${e.path}` : ''))));
    }
    return h('section.card', { 'aria-labelledby': 'holds-h' },
      h('div.card-head', h('h2', { id: 'holds-h' }, 'Recent holds')),
      events.length ? list : h('p.meta', 'Nothing held yet. When an agent reaches for something a red line covers, it shows up here.'));
  }

  function checks(d) {
    const res = h('div');
    const paint = (results) => {
      const hits = (results || []).flatMap((r) => (r.hits ? r.hits.map((x) => ({ id: r.id, ...(typeof x === 'string' ? { file: x } : x) })) : r.file ? [r] : []));
      clear(res).append(results == null ? h('p.meta', 'Checks scan files for patterns, in CI too with npx flowrail check.')
        : hits.length ? h('ul.log', hits.slice(0, 20).map((x) => h('li', h('div', { style: 'min-width:0' }, h('div.s', `${x.file || x.path}${x.line ? ':' + x.line : ''}`), h('div.o', x.message || x.id)))))
          : h('p.meta', h('span.status.ok', icon('check', 14), 'No file breaks a red line.')));
    };
    paint(d.checkRanAt || d.checkResults?.length ? d.checkResults : null);
    return h('section.card', { 'aria-labelledby': 'chk-h' },
      h('div.card-head', h('h2', { id: 'chk-h' }, 'Checks'), h('button.btn.sm', { type: 'button', style: 'margin-left:auto', onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true;
        try { const r = await ctx.api('/redlines', { _action: 'check' }); paint(Array.isArray(r) ? r : r?.results || []); ctx.toast(`Checked ${r?.files ?? 'the'} files`); }
        catch (x) { ctx.toast(x.message, 'warn'); } finally { b.disabled = false; }
      } }, icon('play', 12), 'Run checks')),
      res);
  }

  function headless(hl) {
    const allow = hl?.allowedTools || hl?.allowed, deny = hl?.disallowedTools || hl?.disallowed;
    return h('section.card', { 'aria-labelledby': 'hl-h' },
      h('div.card-head', h('h2', { id: 'hl-h' }, 'Headless runs')),
      h('p.meta', 'Routines and dashboard runs use claude -p in dontAsk mode. Red lines still apply through the guard.'),
      allow && h('div', { style: 'margin-top:10px' }, h('div.label', 'Allowed'), h('div.row', { style: 'margin-top:4px;gap:4px' }, allow.map((t) => h('span.chip.mono', t)))),
      deny && h('div', { style: 'margin-top:10px' }, h('div.label', 'Never allowed'), h('div.row', { style: 'margin-top:4px;gap:4px' }, deny.map((t) => h('span.chip.mono', t)))),
      !allow && !deny && h('p.meta', { style: 'margin-top:8px' }, 'Read-only tools only; writes, web and pushes are off.'));
  }

  function edit(existing) {
    const l = existing ? structuredClone(existing) : { id: '', title: '', why: '', severity: 'ask' };
    sheet(existing ? `Edit ${existing.id}` : 'Add a red line', (body, close) => {
      const f = (id, label, input, hint) => h('div.field', { class: input.dataset.full ? 'full' : '' }, h('label', { for: id }, label), input, hint && h('span.hint', hint), h('span.err', { id: id + '-err', role: 'alert' }));
      const inp = (id, value, extra = {}) => h('input.input', { id, value: value || '', autocomplete: 'off', spellcheck: 'false', ...extra });
      const title = inp('rl-title', l.title, { placeholder: 'Never push without asking' });
      const idIn = inp('rl-id', l.id, { class: 'mono', placeholder: 'no-push-without-asking', readonly: !!existing });
      const why = inp('rl-why', l.why, { placeholder: 'Pushes are public.' });
      const sev = h('select.input', { id: 'rl-sev' }, Object.entries({ block: 'Block: never allowed', ask: 'Ask: hold and ask you', warn: 'Warn: allow, add a note' }).map(([v, t]) => h('option', { value: v, selected: l.severity === v }, t)));
      const htool = h('select.input', { id: 'rl-htool' }, ['Bash', 'Write|Edit', 'Write', 'Edit', '*'].map((t) => h('option', { value: t, selected: (l.hook?.tool || 'Bash') === t }, t)));
      const hmatch = inp('rl-hmatch', l.hook?.match, { class: 'mono', placeholder: '^git push\\b' });
      const cglob = inp('rl-cglob', l.check?.glob, { class: 'mono', placeholder: '**/*.md' });
      const cpat = inp('rl-cpat', l.check?.pattern, { class: 'mono', placeholder: 'regex' });
      const cmsg = inp('rl-cmsg', l.check?.message, { placeholder: 'What the check reports' });
      if (!existing) title.addEventListener('input', () => { idIn.value = title.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48); });
      const setErr = (id, msg) => { const e = body.querySelector(`#${id}-err`); if (e) e.textContent = msg || ''; body.querySelector('#' + id)?.setAttribute('aria-invalid', msg ? 'true' : 'false'); return !msg; };
      const validRe = (s) => { try { new RegExp(s); return ''; } catch (e) { return 'Not a valid regular expression: ' + e.message; } };
      const formErr = h('p.err', { role: 'alert' });
      const calm = h('div', { 'aria-live': 'polite' });
      /** 409 = the change removes or weakens a rule. The server refuses; say how, leave the form as it is. */
      const refused = (x) => {
        if (x.status !== 409) { formErr.textContent = x.message; return; }
        formErr.textContent = '';
        clear(calm).append(h('div.notice.warn', icon('lock'), h('div.body', h('span', WEAKEN),
          h('a.link', { href: '#/docs?path=' + encodeURIComponent('flowrail/red-lines.json'), onclick: close }, 'Open red-lines.json'))));
        calm.scrollIntoView({ block: 'nearest' });
      };
      body.append(h('form.stack', { novalidate: true, onsubmit: async (e) => {
        e.preventDefault();
        let ok = setErr('rl-title', title.value.trim() ? '' : 'Quote the rule as you would say it.');
        ok = setErr('rl-id', /^[a-z0-9][a-z0-9-]*$/.test(idIn.value) ? ((!existing && data.lines.some((x) => x.id === idIn.value)) ? 'That id exists.' : '') : 'Lowercase letters, digits and dashes.') && ok;
        ok = setErr('rl-hmatch', hmatch.value ? validRe(hmatch.value) : '') && ok;
        ok = setErr('rl-cpat', cpat.value ? validRe(cpat.value) : '') && ok;
        if (!ok) return;
        const next = { ...l, id: idIn.value, title: title.value.trim(), why: why.value.trim(), severity: sev.value };
        if (hmatch.value) { next.hook = { ...(l.hook || {}), tool: htool.value, match: hmatch.value }; delete next.hook.builtin; } else if (!l.hook?.builtin) delete next.hook;
        if (cpat.value) next.check = { glob: cglob.value || '**/*', pattern: cpat.value, message: cmsg.value || next.title }; else delete next.check;
        const lines = (existing ? data.lines.map((x) => (x.id === existing.id ? next : x)) : [...data.lines, next]).map(bare);
        clear(calm);
        try { await ctx.api('/redlines', { _action: 'save', lines }); ctx.toast(existing ? 'Red line saved' : 'Red line added'); close(); reload(); ctx.refreshShell(); }
        catch (x) { refused(x); }
      } },
        f('rl-title', 'The rule, in your words', title),
        h('div.form-grid', f('rl-id', 'Id', idIn), f('rl-sev', 'When it matches', sev)),
        f('rl-why', 'Why', why, 'The agent sees this when it is held.'),
        h('div', h('div.label', 'Hook'), h('p.meta', 'Makes it Armed. Matched against each command after flowrail strips sudo, env and paths, or against the file path.')),
        l.hook?.builtin && h('p.meta', 'Uses the built-in matcher ', h('span.mono', l.hook.builtin), l.params?.glob ? [' on ', h('span.mono', l.params.glob)] : '', l.floor ? '. It is part of the guard and always runs.' : '. Leave Match empty to keep it, or write a regex to replace it.'),
        h('div.form-grid', f('rl-htool', 'Tool', htool), f('rl-hmatch', 'Match (regex)', hmatch)),
        h('div', h('div.label', 'Check (optional)'), h('p.meta', 'Scans files with npx flowrail check, in CI too.')),
        h('div.form-grid', f('rl-cglob', 'Files', cglob), f('rl-cpat', 'Pattern (regex)', cpat)),
        f('rl-cmsg', 'Message', cmsg),
        formErr, calm,
        h('div.row', existing && !existing.floor && h('button.btn.danger', { type: 'button', onclick: async () => {
          if (!(await confirmBox(`Remove “${existing.title}”? Agents will no longer be held by it.`, 'Remove'))) return;
          try { await ctx.api('/redlines', { _action: 'save', lines: data.lines.filter((x) => x.id !== existing.id).map(bare) }); close(); reload(); ctx.refreshShell(); ctx.toast('Red line removed'); } catch (x) { refused(x); }
        } }, 'Remove'), h('span.spacer'), h('button.btn', { type: 'button', onclick: close }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'Save'))));
      title.focus();
    });
  }

  const reload = loader(root, () => ctx.api('/redlines'), render, 5);
  ctx.on(['redlines'], () => { if (!document.querySelector('dialog[open]') && !document.activeElement?.matches?.('input, textarea, select')) reload(); });
  return () => {};
}
/** Server-computed fields never go back into red-lines.json. */
const bare = ({ summary, state, ...rest }) => rest;
