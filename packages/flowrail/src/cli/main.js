// CLI dispatcher. Each command lives in a small module and is loaded on demand.
import { parseArgs, out, err, c, LEGEND } from './ui.js';
import { VERSION } from '../core/workspace.js';
import { findRoot, paths } from '../core/paths.js';

export const HELP = `${c.bold('flowrail')} ${VERSION}  Guardrails for Claude Code that hold.

${c.bold('Start')}
  flowrail init                   the guard: red lines and hooks, nothing else  ${c.dim('--yes')}
  flowrail status                 is the guard live, what it holds, what it held this week
  flowrail doctor                 check the setup and print fixes

${c.bold('Red lines')}
  flowrail redlines               list red lines  ${c.dim('add <recipe> | add --list')}
  flowrail redlines test "<cmd>"  what the red lines do with one command (works without a workspace)
  flowrail redlines verify        probe every red line: calls it must hold and calls it must allow
  flowrail redlines accept        review and accept red-lines.json changes made outside flowrail
  flowrail check                  run red-line checks over the repo; exit 1 on block hits
  flowrail audit                  replay your recent Claude Code sessions through the red lines  ${c.dim('--days 30  --json  --demo')}
  flowrail hooks                  install | uninstall | status

${c.bold('Maintenance')}
  flowrail upgrade                restore the guard in .claude/flowrail/guard/ and refresh its hooks
  flowrail uninstall              remove the guard and its hooks; flowrail/ stays

${c.dim(LEGEND)}
${c.dim('Dashboard, tasks, comments and routines: npx @finalangel/flowrail-os (optional, separate package)')}
`;

const COMMANDS = {
  init: ['./setup.js', 'init'],
  guard: ['./setup.js', 'guard'],
  upgrade: ['./setup.js', 'upgrade'],
  uninstall: ['./setup.js', 'uninstall'],
  hooks: ['./setup.js', 'hooks'],
  doctor: ['./safety.js', 'doctor'],
  status: ['./safety.js', 'status'],
  check: ['./safety.js', 'check'],
  redlines: ['./safety.js', 'redlines'],
  audit: ['./audit.js', 'audit'],
};

/** Commands that live in flowrailOS; `flowrail <cmd>` hands them to flowrail-os. */
const ROOM_COMMANDS = new Set(['start', 'demo', 'today', 'task', 'tasks', 'comments', 'resolve', 'remember', 'recall', 'routines']);

/** The workspace for the current folder, or exit with a helpful message. */
export function workspace() {
  const root = findRoot(process.cwd());
  if (!root) {
    err('no workspace in this folder or its parents.');
    out(`  ${c.cyan('npx flowrail init')}   set one up here`);
    out(`  ${c.cyan('npx @finalangel/flowrail-os demo')}   look around a sample workspace first`);
    process.exit(1);
  }
  return paths(root);
}

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  if (flags.version) return out(VERSION);
  const name = pos[0] && !pos[0].startsWith('-') ? pos[0] : 'help';
  // flowrailOS commands go to flowrail-os with their raw argv, flags (and --help) included.
  const entry = name === 'room' ? ['./room.js', 'room', argv.filter((a, i) => i !== argv.indexOf('room'))]
    : ROOM_COMMANDS.has(name) ? ['./room.js', 'room', argv] : COMMANDS[name];
  if ((flags.help && entry?.[1] !== 'room') || name === 'help') return out(HELP);
  if (!entry) {
    err(`unknown command "${name}".`);
    out(`Run ${c.cyan('flowrail help')} for the list.`);
    process.exitCode = 1;
    return;
  }
  try {
    const mod = await import(entry[0]);
    await mod[entry[1]](entry[2] ?? pos.slice(name === pos[0] ? 1 : 0), flags);
  } catch (e) {
    err(e.message);
    if (process.env.FLOWRAIL_DEBUG) console.error(e);
    process.exitCode = e.exitCode || 1;
  }
}
