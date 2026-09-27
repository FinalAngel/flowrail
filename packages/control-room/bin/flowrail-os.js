#!/usr/bin/env node
// flowrailOS CLI entry. The guard commands are the flowrail package's.
const { main } = await import('../src/cli/main.js');
await main(process.argv.slice(2));
