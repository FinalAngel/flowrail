// flowrail/api: the small, stable surface other packages (the control room) build on.
// Everything else under src/ is internal and may change between versions.
import { paths } from './core/paths.js';
import { loadConfig } from './core/workspace.js';
import { portRange } from './guard/builtins.js';
import { loadLines, decide, reasonFor } from './core/redlines.js';

export { paths, findRoot, safePath, isServable, PathError } from './core/paths.js';
export { loadConfig, saveConfig, workspaceInfo, gitInfo, defaultConfig } from './core/workspace.js';
export { hooksStatus, hooksSummary, mergeHooks, vendorGuard, cliName, GUARD_REL } from './core/hooks.js';
export {
  driftStatus, verifyRedlines, describe as describeRedlines, describe, loadLines, validateLines,
  weakenings, logChange, holds, changes, changeText, stats, stateCounts, stateSummary, runChecks,
  cachedChecks, walkFiles,
} from './core/redlines.js';
export { auditSummary } from './core/audit.js';
export { appendJournal, verifyJournal } from './core/journal.js';
export {
  planInit, planInit as planGuardSetup, withBlock, BLOCK_START, BLOCK_END, apply as applyPlan,
  freshEpoch,
} from './core/init.js';
export { stateDir, signComment, commentVerified, journalPath } from './guard/state.js';
export { run as doctor } from './core/doctor.js';
export {
  addDays, appendLine, exists, listFiles, localDate, mondayOf, moveToTrash, nowIso, pad, parseDate,
  randomId, readJson, readJsonl, readText, slugify, stamp, trashJson, writeJson, writeText,
} from './core/util.js';
export { parseArgs, out, err, c, mark, json, ago, when, confirm } from './cli/ui.js';
export { main as cliMain, workspace } from './cli/main.js';
export { init as cliInit } from './cli/setup.js';

/**
 * Ask the guard what it would do with one call, exactly as the hook would (no journal entry).
 * @param {string|object} rootOrPaths workspace root or paths(root)
 * @param {{tool?:string, subject?:string, input?:object}} call
 */
export function testCommand(rootOrPaths, { tool = 'Bash', subject = '', input } = {}) {
  const p = typeof rootOrPaths === 'string' ? paths(rootOrPaths) : rootOrPaths;
  const args = input || (tool === 'Bash' ? { command: String(subject) } : { file_path: String(subject) });
  const r = decide(loadLines(p), tool, args, { root: p.root, cwd: p.root, ports: portRange(loadConfig(p).port) });
  return { decision: r.decision, line: r.line || null, what: r.what || null, normalized: r.normalized, reason: r.line ? reasonFor(r.line, r) : null };
}
