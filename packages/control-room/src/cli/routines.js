// flowrail routines install | uninstall | status | run <id>
import { out, c, mark, json, ago, when, confirm } from 'flowrail/api';
import { workspace } from 'flowrail/api';
import * as routines from '../core/routines.js';

export async function routines_(pos, flags) {
  const p = workspace();
  const sub = pos[0] || 'status';
  if (sub === 'status') {
    const list = routines.list(p);
    if (flags.json) return json(list);
    if (!list.length) return out('No routines. Add one to flowrail/routines.json.');
    for (const r of list) {
      const last = r.lastRun ? (r.lastRun.exit === 0 ? c.green(`ok ${ago(r.lastRun.at)}`) : c.yellow(`failed ${ago(r.lastRun.at)}`)) : c.dim('never ran');
      const inst = !r.enabled ? c.dim('disabled') : r.installed ? c.green('scheduled') : c.dim('not scheduled');
      out(`  ${c.bold(r.id.padEnd(20))} ${r.scheduleText.padEnd(22)} ${inst.padEnd(22)} ${last}${r.next && r.installed ? c.dim(`  next ${when(r.next)}`) : ''}`);
      if (r.lastRun && r.lastRun.exit !== 0 && r.lastRun.firstLine) out(`  ${' '.repeat(20)} ${c.dim(r.lastRun.firstLine)}`);
    }
    if (list.some((r) => r.enabled && !r.installed)) out(c.dim('\nSchedule them: npx @flowrail/control-room routines install'));
    return;
  }
  if (sub === 'install') {
    // Show exactly what will be scheduled. A routines.json from a clone never installs silently.
    const list = routines.list(p).filter((r) => r.enabled);
    if (!list.length) return out(`Nothing to schedule. Set "enabled": true on a routine in flowrail/routines.json.`);
    out(c.bold('Will schedule'));
    for (const r of list) {
      out(`  ${c.bold(r.id.padEnd(20))} ${r.scheduleText}`);
      if (r.run.type === 'command') out(`    ${c.yellow('runs')} ${r.run.cmd.map((a) => JSON.stringify(String(a))).join(' ')}`);
      else out(`    ${c.dim('claude -p (read-only tools):')} ${String(r.run.prompt).replace(/\s+/g, ' ').slice(0, 100)}`);
    }
    if (!flags.yes) {
      const ok = await confirm('\nSchedule these on this machine?', false);
      if (ok === null) { out(`${mark.warn} Not an interactive terminal, so nothing was scheduled. Re-run with ${c.cyan('--yes')} after reading the list.`); process.exitCode = 2; return; }
      if (!ok) return out('Nothing scheduled.');
    }
    const r = routines.install(p);
    if (r.instructions) {
      out(`${mark.warn} No scheduler support on ${r.platform}. Add these to your task scheduler:`);
      for (const i of r.instructions) out(`  ${i}`);
      return;
    }
    return out(r.installed.length ? `${mark.ok} Scheduled with ${r.platform}: ${r.installed.join(', ')}` : `Nothing to schedule. Set "enabled": true on a routine in flowrail/routines.json.`);
  }
  if (sub === 'uninstall') {
    const r = routines.uninstall(p);
    return out(r.removed.length ? `${mark.ok} Unscheduled: ${r.removed.join(', ')}` : 'Nothing was scheduled.');
  }
  if (sub === 'run') {
    if (!pos[1]) throw new Error('usage: npx @flowrail/control-room routines run <id>');
    if (!flags.json) out(c.dim(`Running ${pos[1]}...`));
    const rec = await routines.runNow(p, pos[1]);
    if (flags.json) return json(rec);
    out(rec.exit === 0 ? `${mark.ok} ${pos[1]} finished. Output: .flowrail/runs/${rec.id}.log` : `${mark.fail} ${pos[1]} exited ${rec.exit}. Output: .flowrail/runs/${rec.id}.log`);
    if (rec.exit !== 0) process.exitCode = 1;
    return;
  }
  throw new Error('usage: npx @flowrail/control-room routines install|uninstall|status|run <id>');
}
export { routines_ as routines };
