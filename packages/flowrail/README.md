# flowrail

Guardrails for Claude Code that hold. A `PreToolUse` hook parses every command before it runs, and the agent cannot quietly switch it off.

![A terminal: npx flowrail init verifies 7 red lines; in a Claude Code session, git push --force origin main and rm -rf ~ are blocked with the reason; npx flowrail audit --demo lists what flowrail would have held or asked in fictional sessions beyond what settings.json already catches.](https://raw.githubusercontent.com/FinalAngel/flowrail/main/assets/demo.svg)

```sh
npx flowrail redlines test "git push --force origin main"   # try it; no install, no workspace needed
npx flowrail init                                           # add the guard to this repo; shows every change, then asks
npx flowrail audit                                          # what it would have caught in your past sessions (--demo: fictional ones)
```

With Gmail, Stripe and Google Calendar connected and the `no-payments` recipe added, `create_draft` is allowed, Gmail `send_message` and Calendar `create_event` ask (invites go out), and Stripe `create_refund` is blocked. *block* = the call never runs; *ask* = Claude Code asks you first.

Out of the box it blocks destructive git (force pushes, hard resets, forced cleans and branch deletes), `rm -rf` outside the project and writing secrets, and it asks before any other push, before reading secrets and before an MCP tool sends, merges, deletes or pays. Drafts are fine. `init` offers more red lines for what your repo uses: mail and payment servers, deploys, infrastructure, databases and paths you name in `CLAUDE.md`.

The guard also guards itself. Commands that would edit or empty its files, the rules or the settings ask first. The hook command in `settings.json` checks every guard file against its manifest, and the manifest against a hash pinned in the command, so a guard that is deleted, emptied or edited, or a missing `node`, blocks the call. Rules changed outside flowrail make every call ask until you review them with `npx flowrail redlines accept` in your own terminal.

`init` copies the guard (plain Node files, no dependencies) into `.claude/flowrail/guard/`, writes `flowrail/red-lines.json` and adds hook entries to `.claude/settings.json`. It reads the rules in your `CLAUDE.md`, says which ones are covered or only partly covered, and ends by probing every red line (`npx flowrail redlines verify` does the same later). Commit the files and everyone who clones is guarded, with no `npm install`.

About 50 ms per tool call on a laptop, about 30 ms of it Node starting. The bypass corpus runs in CI: 848 bypass probes held, 330 false-positive probes allowed, 22 known gaps documented. `npx flowrail audit` shows what it adds beyond the `deny` and `ask` rules in your `settings.json`. No network, no telemetry. The optional dashboard is a separate package, [`@flowrail/control-room`](https://www.npmjs.com/package/@flowrail/control-room).

Docs, the tamper model and the bypass corpus: https://github.com/FinalAngel/flowrail. MIT.
