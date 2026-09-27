// flowrailOS's commands; anything else goes to the flowrail (guard) CLI.
import { parseArgs, out, err } from 'flowrail/api';
import { cliMain as guardMain } from 'flowrail/api';
import { VERSION } from '../core/pkg.js';

export const HELP = `flowrailOS ${VERSION}

Usage: npx @finalangel/flowrail-os <command>   (installed: flowrail-os <command>)

  (no command)            dashboard on http://127.0.0.1:4747  --port N  --no-open
  init                    the guard plus flowrailOS (board, docs, memory)  --yes  --agents-md
  demo                    open a sample workspace in a temp folder  --port N  --no-open
  status                  one-screen summary
  today                   what happened since this morning  --json
  task "<title>"          file a task in the current sprint  --priority P1 --sprint next|backlog --assignee x --label x
  task update <id>        --status "In Progress" --priority P0 --assignee claude ...
  task note <id> "text"
  tasks                   open tasks in this sprint  --all  --json
  comments                open comments on docs  --json
  resolve <path> <id>     mark a comment done  --note "what you did"
  remember "<fact>"       store a memory  --type project|feedback|user|reference --name slug --why --how
  recall "<question>"     find memories and doc sections, no model call  --json
  routines                install | uninstall | status | run <id>
  board export            the current sprint as one standalone HTML file  --out file.html  --backlog

Guard commands (redlines, check, audit, doctor, hooks, upgrade, uninstall) belong to the guard: npx flowrail --help
They work here too.
`;

const COMMANDS = {
  start: ['./start.js', 'start'],
  demo: ['./start.js', 'demo'],
  init: ['flowrail/api', 'cliInit'],
  status: ['./work.js', 'status'],
  today: ['./work.js', 'today'],
  task: ['./work.js', 'task'],
  tasks: ['./work.js', 'tasks'],
  comments: ['./work.js', 'comments'],
  resolve: ['./work.js', 'resolve'],
  remember: ['./work.js', 'remember'],
  recall: ['./work.js', 'recall'],
  routines: ['./routines.js', 'routines'],
  board: ['./board.js', 'board_'],
};

export async function main(argv) {
  const { flags, pos } = parseArgs(argv);
  if (flags.version) return out(VERSION);
  const name = pos[0] && !pos[0].startsWith('-') ? pos[0] : 'start';
  if (flags.help || name === 'help') return out(HELP);
  const entry = COMMANDS[name];
  if (!entry) return guardMain(argv);
  try {
    const mod = await import(entry[0]);
    // init is the guard's init with flowrailOS's files on top.
    const room = name === 'init' ? (await import('../core/init.js')).room : undefined;
    await mod[entry[1]](pos.slice(name === pos[0] ? 1 : 0), flags, room);
  } catch (e) {
    err(e.message);
    if (process.env.FLOWRAIL_DEBUG) console.error(e);
    process.exitCode = e.exitCode || 1;
  }
}
