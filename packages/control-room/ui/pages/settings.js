import { h, icon, clear, loader, cmd, skeleton, errorBox } from '../lib/dom.js';
import { doctorList } from './security.js';

const MODULES = ['board', 'docs', 'knowledge', 'memory', 'routines', 'workflows', 'team', 'redlines', 'artifacts'];
const LABEL = { knowledge: 'Graph', redlines: 'Red lines' };

export function mount(el, ctx) {
  const form = h('div');
  const doctor = h('div');
  el.append(h('header.page-head', h('div', h('h1', 'Settings'), h('p.sub', 'flowrail/config.json and a health check of this machine.'))),
    h('div.two', h('section.card', { 'aria-labelledby': 'cfg-h' }, h('div.card-head', h('h2', { id: 'cfg-h' }, 'Workspace')), form),
      h('section.card', { 'aria-labelledby': 'dr-h' }, h('div.card-head', h('h2', { id: 'dr-h' }, 'Doctor'), h('button.btn.sm', { type: 'button', style: 'margin-left:auto', onclick: () => runDoctor() }, icon('refresh', 12), 'Run again')), doctor)));

  async function loadConfig() {
    try { return { cfg: await ctx.api('/config'), editable: true }; }
    catch (e) {
      if (e.status !== 404) throw e;
      const f = await ctx.api('/docs/file?path=' + encodeURIComponent('flowrail/config.json'));
      return { cfg: JSON.parse(f.text), editable: false };
    }
  }
  function render({ cfg, editable }) {
    const mods = { ...Object.fromEntries(MODULES.map((m) => [m, true])), ...(cfg.modules || {}) };
    const keys = Object.keys(mods);
    const name = h('input.input', { id: 's-name', value: cfg.name || '', disabled: !editable });
    const port = h('input.input.mono', { id: 's-port', type: 'number', min: 1024, max: 65535, value: cfg.port || 4747, disabled: !editable });
    const len = h('select.input', { id: 's-len', disabled: !editable }, [7, 14, 21, 28].map((n) => h('option', { value: n, selected: (cfg.sprintLength || 14) === n }, `${n} days`)));
    const toggles = keys.map((m) => h('label.switch', h('input', { type: 'checkbox', name: m, checked: mods[m] !== false, disabled: !editable }), LABEL[m] || m[0].toUpperCase() + m.slice(1)));
    const err = h('p.err', { role: 'alert' });
    form.append(h('form.stack', { onsubmit: async (e) => {
      e.preventDefault();
      const p = Number(port.value);
      if (!(p >= 1024 && p <= 65535)) { err.textContent = 'Port must be between 1024 and 65535.'; port.setAttribute('aria-invalid', 'true'); return; }
      const modules = Object.fromEntries(toggles.map((t) => { const i = t.querySelector('input'); return [i.name, i.checked]; }));
      try { await ctx.api('/config', { name: name.value.trim(), port: p, sprintLength: Number(len.value), modules }); err.textContent = ''; ctx.toast('Saved. A new port applies on the next start.'); ctx.refreshShell(); }
      catch (x) { err.textContent = x.message; }
    } },
      !editable && h('div.notice.warn', icon('alert'), h('div.body', h('span', 'This server cannot write the config. Edit flowrail/config.json in your editor; the dashboard picks it up.'))),
      h('div.form-grid', h('div.field', h('label', { for: 's-name' }, 'Name'), name), h('div.field', h('label', { for: 's-port' }, 'Port'), port),
        h('div.field', h('label', { for: 's-len' }, 'Sprint length'), len), h('div.field', h('span.label', 'Sprint starts'), h('span.mono', { style: 'min-height:36px;display:flex;align-items:center' }, cfg.sprintStart || '—'))),
      h('fieldset', { style: 'border:0;padding:0;margin:0' }, h('legend.label', { style: 'margin-bottom:6px' }, 'Modules'), h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:0 12px' }, toggles)),
      err, editable && h('div.row', h('button.btn.primary', { type: 'submit' }, 'Save'))),
      h('hr.sep'), h('div.label', { style: 'margin-bottom:6px' }, 'Remove the guard, its hook entries and the CLAUDE.md block. Your flowrail/ files stay.'), cmd('npx flowrail uninstall', ctx));
  }
  async function runDoctor() {
    clear(doctor).append(skeleton(4));
    try { const d = await ctx.api('/doctor'); clear(doctor).append(doctorList(d, ctx)); }
    catch (e) { clear(doctor).append(errorBox(e, runDoctor)); }
  }
  loader(form, loadConfig, render, 5);
  runDoctor();
  return () => {};
}
