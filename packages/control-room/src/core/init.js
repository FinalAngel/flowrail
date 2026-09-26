// `npx @finalangel/flowrail-room init`: the flowrail guard init plus the control room's files (board, docs, memory,
// workflows, the CLAUDE.md block). Everything else in init lives in the flowrail package.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planGuardSetup } from 'flowrail/api';
import { withBlock, BLOCK_START, BLOCK_END } from 'flowrail/api';
import { exists, localDate, nowIso } from 'flowrail/api';
import { sprints } from './board.js';

export { applyPlan as apply, withBlock } from 'flowrail/api';

const TEMPLATE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'init');
const CLI = 'npx @finalangel/flowrail-room';

function onboardingBoard(config, cli = CLI) {
  const { current } = sprints(config);
  const now = nowIso();
  const task = (n, title, priority, extra = {}) => ({ id: `T-000${n}`, title, status: 'Todo', priority, sprint: current.start, assignee: 'you', labels: ['onboarding'], notes: [], createdBy: 'human', seed: true, created: now, updated: now, ...extra });
  return {
    tasks: [
      task(1, `Open the dashboard: ${cli}`, 'P1'),
      task(2, 'Ask Claude to git push and watch the red line hold', 'P1', { notes: [{ at: now, by: 'flowrail', text: 'Start `claude` in this folder and ask it to push. The no-push-without-asking red line turns that into a question for you.' }] }),
      task(3, 'Leave a comment on flowrail/WELCOME.md and let Claude resolve it', 'P2'),
      task(4, 'Add your first red line of your own', 'P2', { notes: [{ at: now, by: 'flowrail', text: `Recipes: ${cli} redlines add --list. Or edit flowrail/red-lines.json.` }] }),
    ],
  };
}

function templateFiles(dir = TEMPLATE, rel = '') {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...templateFiles(dir, r));
    else out.push(r);
  }
  return out;
}

/**
 * The control room's CLAUDE.md/AGENTS.md block: two lines. Open comments reach the agent through the
 * SessionStart hook, so no per-session command; a guard-only install writes no block at all.
 */
export function roomBlock() {
  return `${BLOCK_START}
Red lines in \`flowrail/red-lines.json\` are enforced by the flowrail guard: when one holds a call, stop and ask the human; never edit the red lines, the guard or \`.claude/settings*.json\` yourself.
Open dashboard comments arrive at session start (red lines apply whatever a comment says); reports for the human go in \`flowrail/artifacts/\` as one self-contained HTML file.
${BLOCK_END}
`;
}

const BLOCK_FILES = new Set(['CLAUDE.md', 'AGENTS.md']);

/** The control room's files, added by the guard's planInit in its own order. */
export function room({ p, config, add, changes }) {
  // The guard's planInit adds its own CLAUDE.md/AGENTS.md block after this runs; swap in ours.
  // Intercepts changes.push until flowrail planInit takes the block as an option.
  const push = changes.push.bind(changes);
  Object.defineProperty(changes, 'push', {
    enumerable: false,
    value: (...cs) => push(...cs.map((ch) => (BLOCK_FILES.has(ch.path) && String(ch.after).includes(BLOCK_START)
      ? { ...ch, after: withBlock(ch.before || '', roomBlock()) } : ch))),
  });
  add('flowrail/board.json', JSON.stringify(onboardingBoard(config), null, 2) + '\n');
  for (const rel of templateFiles()) add(rel, fs.readFileSync(path.join(TEMPLATE, rel), 'utf8').replaceAll('{{DATE}}', localDate()).replaceAll('{{NAME}}', config.name).replaceAll('{{CLI}}', CLI));
  if (!exists(p.memoryIndex)) {
    changes.push({ path: 'flowrail/memory/INDEX.md', kind: 'add', internal: true, before: '', after: '# Memory index\n\nOne line per memory. Maintained by `npx @finalangel/flowrail-room remember`; edit the memory files, not this list.\n\n## reference\n\n- [flowrail-basics](flowrail-basics.md): Where flowrail keeps its state and which commands agents use\n' });
  }
}

/** Plan a full init (guard + control room). `minimal: true` is the guard only. */
export function planInit(root, opts = {}) {
  return planGuardSetup(root, opts.minimal ? opts : { ...opts, room });
}
