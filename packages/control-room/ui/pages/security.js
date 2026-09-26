import { h, icon, loader, cmd } from '../lib/dom.js';

/** Doctor results as a checklist; shared with Settings. */
export function doctorList(d, ctx) {
  const checks = Array.isArray(d) ? d : d?.checks || [];
  return h('ul.checks', checks.map((c) => {
    const cls = c.ok ? 'ok' : c.level === 'warn' || c.optional ? 'warn' : 'bad';
    return h('li', { class: cls }, icon(c.ok ? 'check' : 'alert'),
      h('div', { style: 'flex:1;min-width:0' }, h('div', c.title || c.id, c.detail && h('span.meta', ` · ${c.detail}`)),
        !c.ok && c.fix && (/^(npx|flowrail|npm|brew|claude|git)\b/.test(c.fix) ? h('div', { style: 'margin-top:6px' }, cmd(c.fix, ctx)) : h('div.meta', c.fix))));
  }));
}

export function mount(el, ctx) {
  const root = h('div');
  el.append(root);
  const render = ([doc, rl]) => {
    const hl = rl?.headless && { allowedTools: rl.headless.allowedTools || rl.headless.allowed, disallowedTools: rl.headless.disallowedTools || rl.headless.disallowed };
    root.append(
      h('header.page-head', h('div', h('h1', 'Security'), h('p.sub', 'What flowrail checks, what it stops, and where it stops.'))),
      h('div.two.stagger',
        h('section.card', { 'aria-labelledby': 'doc-h' }, h('div.card-head', h('h2', { id: 'doc-h' }, 'Doctor'), h('button.btn.sm', { type: 'button', style: 'margin-left:auto', onclick: reload }, icon('refresh', 12), 'Run again')), doctorList(doc, ctx)),
        h('section.card', { 'aria-labelledby': 'tm-h' }, h('div.card-head', h('h2', { id: 'tm-h' }, 'How the dashboard is protected')),
          h('ul.bullets',
            h('li', h('strong', 'Loopback only. '), 'The server binds 127.0.0.1 and refuses other Host headers, which blocks DNS rebinding.'),
            h('li', h('strong', 'A key per run. '), 'Every API call needs a random token that changes each time flowrail starts. It lives only in this page, never on disk. A tab from an older run asks you to reload.'),
            h('li', h('strong', 'Secrets stay unread. '), '.env files, keys, credentials, .git and private/ folders are never served.'),
            h('li', h('strong', 'Artifacts are sandboxed. '), 'Agent reports run in a sandboxed frame and cannot call the API.'),
            h('li', h('strong', 'Nothing is deleted. '), 'Deletes move files to .flowrail/trash.'),
            h('li', h('strong', 'No telemetry. '), 'flowrail makes no network calls of its own.'))),
        h('section.card', { 'aria-labelledby': 'can-h' }, h('div.card-head', h('h2', { id: 'can-h' }, 'What red lines can stop')),
          h('ul.bullets',
            h('li', 'Any Claude Code tool call that matches a hook, before it runs: Bash commands, file writes and edits.'),
            h('li', 'Common disguises: sudo, env assignments, full binary paths, git -C and -c, sh -c wrappers, chained commands.'),
            h('li', 'Files that break a check, locally and in CI with npx flowrail check.'))),
        h('section.card', { 'aria-labelledby': 'cant-h' }, h('div.card-head', h('h2', { id: 'cant-h' }, 'What they cannot stop')),
          h('ul.bullets',
            h('li', 'Anything run outside Claude Code, including by you in a terminal.'),
            h('li', 'Sessions started with the guard switched off, or a settings file someone edited.'),
            h('li', 'A command built at runtime that no regex can see, such as a script that pushes for you.'),
            h('li', 'It is a seatbelt, not a jail. Keep real credentials scoped.'))),
        h('section.card', { 'aria-labelledby': 'hl2-h', style: 'grid-column:1/-1' }, h('div.card-head', h('h2', { id: 'hl2-h' }, 'Headless runs')),
          h('p.meta', 'Routines and dashboard runs call claude -p with --permission-mode dontAsk, one at a time, output capped and logged in .flowrail/runs.'),
          hl?.allowedTools && h('div', { style: 'margin-top:10px' }, h('div.label', 'Allowed tools'), h('div.row', { style: 'gap:4px;margin-top:4px' }, hl.allowedTools.map((t) => h('span.chip.mono', t)))),
          hl?.disallowedTools && h('div', { style: 'margin-top:10px' }, h('div.label', 'Never allowed'), h('div.row', { style: 'gap:4px;margin-top:4px' }, hl.disallowedTools.map((t) => h('span.chip.mono', t)))))));
  };
  const reload = loader(root, () => Promise.all([ctx.api('/doctor'), ctx.api('/redlines').catch(() => null)]), render, 5);
  return () => {};
}
