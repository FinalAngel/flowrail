// flowrail-room board export [--out file.html] [--backlog]: the current sprint as a standalone HTML file.
// The CLI reads flowrail/board.json; a plugin's board store is exported from code with boardHtml().
import fs from 'node:fs';
import path from 'node:path';
import { out, workspace, loadConfig, localDate } from 'flowrail/api';
import * as board from '../core/board.js';
import { boardHtml } from '../core/export.js';

export function board_(pos, flags) {
  if (pos[0] !== 'export') throw Object.assign(new Error('usage: board export [--out file.html] [--backlog]'), { exitCode: 2 });
  const p = workspace();
  const config = loadConfig(p);
  const file = typeof flags.out === 'string' ? path.resolve(flags.out) : path.join(p.local, 'exports', `board-${localDate()}.html`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, boardHtml(board.read(p, config), { name: config.name, backlog: !!flags.backlog }));
  out(file);
}
