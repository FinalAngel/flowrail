# Roadmap

What is planned, roughly in order. Nothing here has a date. If something matters to you, say so in [Discussions](https://github.com/FinalAngel/flowrail/discussions); that is how the order changes.

## Next

- **More built-in matchers.** More CLIs and MCP servers, beyond the built-in matchers (git, deletes, secrets, MCP tools, email, payments, publishing, infrastructure, databases) and the eighteen recipes in `packages/flowrail/examples/red-lines/`. Each with a probe file in `packages/flowrail/test/corpus/` for what it holds and what it lets through.
- **Closing gaps that can be closed without guessing.** The [known gaps](docs/red-lines.md#what-a-red-line-does-not-hold) are `GAP` lines in the corpus; a gap that becomes a passing `HOLD` line moves off the list.
- **Windows routines** through Task Scheduler, instead of printed instructions.

## Later

- **Adapters for other agent CLIs** (Codex CLI, Gemini CLI, opencode). The adapter interface is planned, not built; [docs/extending.md](docs/extending.md#adapters-for-other-agent-clis) sketches it. The first question for each CLI is whether its hooks can refuse a tool call.
- **Shared comments**, stored in the repo instead of per machine, for teams that want them reviewed in git.
- **A stable file format and HTTP API** for 1.0, with a migration command for anything that changes on the way there.

## Not planned

- A hosted version, accounts or sync. flowrail stays local and file-based.
- Running agent sessions in parallel or managing worktrees. Other tools do this well, and flowrail works alongside them.
- Semantic memory with embeddings. It would need a model or a dependency. Recall stays deterministic.
