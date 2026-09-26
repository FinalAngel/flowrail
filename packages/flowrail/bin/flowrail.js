#!/usr/bin/env node
// flowrail CLI entry. Hooks take a fast path that loads only the guard.
// `flowrail guard` (no subcommand) is `flowrail hook pre-tool-use`; `flowrail guard init` sets up the guard only.
const args = process.argv.slice(2);
// `flowrail audit --json | head` closes the pipe early: that is fine, not a crash.
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
if (args[0] === 'hook' || (args[0] === 'guard' && !args[1])) {
  const { main } = await import('../src/guard/hook.mjs');
  await main(args[0] === 'guard' ? 'pre-tool-use' : args[1]);
} else {
  const { main } = await import('../src/cli/main.js');
  await main(args);
}
