// The Backlog page: the board module in backlog mode (every open task, every sprint, one table).
import { mount as board } from './board.js';

export const mount = (el, ctx) => board(el, { ...ctx, mode: 'backlog' });
