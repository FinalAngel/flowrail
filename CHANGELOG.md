# Changelog

All notable changes to flowrail are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/). Before 1.0, minor versions may change file formats and the HTTP API; any such change is listed here with what to do about it.

## [Unreleased]

### Added

- The Graph page has three views, switched in the header and remembered per browser (`#/knowledge?view=graph|rings|tree`). **Rings** draws the repo around `CLAUDE.md` on one rhythm: skills and commands, area markers, documents grouped by area (a folder with many documents is one star with its count), routines and red lines, artifacts. **Tree** is the folder hierarchy with counts and area chips, navigable with the arrow keys. Areas come from `areas` in `flowrail/config.json` or a router table in `CLAUDE.md`; `GET /api/graph` now returns `areas`, and `ring` and `area` on each node.

## [0.1.0] (unreleased)

First public release. Not yet on npm. Two packages: `flowrail`, the guard and its CLI, and `@finalangel/flowrail-room` (command `flowrail-room`), the optional dashboard.

### Added

- Red lines in `flowrail/red-lines.json` with `block`, `ask` and `warn` severities, enforced by a Claude Code `PreToolUse` hook and by file checks in CI (`flowrail check`). Each rule has one state everywhere: armed, checked in CI, declared only, or not enforced.
- Built-in matchers that parse a command into argv and read its flags: `git-push`, `git-destructive`, `rm-dangerous`, `secret-files`, `flowrail-tamper`, `mcp-actions`, `email-send`, `payments`, `publish-deploy`, `infra-destructive`, `db-destructive` and `protect-path`. Regex lines are still supported. A shell parser undoes quoting and escapes (`\git pu\sh`, `g''it`), strips wrappers (`sudo`, `env`, `timeout`, `xargs`), unwraps `sh -c`, `eval`, command substitutions, heredocs fed to a shell and inline `python -c` scripts, and treats other heredoc bodies as data.
- A public probe corpus in `packages/flowrail/test/corpus/` that CI runs: 848 bypass probes held, 330 false-positive probes allowed, 22 known gaps documented (`node packages/flowrail/scripts/corpus-stats.js`).
- Six starter red lines on every install: `no-push-without-asking`, `no-destructive-git`, `no-secrets-in-repo`, `no-rm-rf-outside-project`, `ask-before-mcp-actions` and `protect-flowrail`. `init` also offers starters for what the project uses (`publish-deploy`, `infra-destructive`, `db-destructive`, and `no-emails-without-signoff` or `no-payments` for mail and payment MCP servers).
- A vendored guard: `flowrail init` copies the guard's plain Node files and a hash manifest into `.claude/flowrail/guard/`, and the committed hooks run them with `node`. It works in a fresh clone with no `npm install` and does not touch `package.json`. A call takes about 50 ms on a laptop when allowed and 54 ms when held (median), about 30 ms of it Node starting up. Tools that cannot act (Glob, WebFetch, Task) do not start it.
- A hook that fails closed: the command in `settings.json` checks every guard file against its manifest, and the manifest against a hash pinned in the command, before it imports the guard. A guard that is missing, emptied, garbled or edited (even together with its manifest), or a missing `node`, exits with code 2 and blocks the call; inside a workspace, unreadable red lines, a regex that does not compile or unparseable input become an `ask` with the reason. The remaining gap, a file swapped between the check and the import, is listed in `docs/tamper-model.md`.
- Tamper resistance, documented row by row in `docs/tamper-model.md`: `protect-flowrail` is compiled into the guard and cannot be removed or lowered from `red-lines.json`; it asks before commands that would neuter the guard, including through globs, loops, `find | xargs`, `find -exec` and trees copied over the project (`cp -r`, `rsync`, `tar -x`), and before changes to git's executable config and environment (`core.fsmonitor`, `GIT_SSH_COMMAND` and others) and shell startup files; the guard's files are checked against the hashes shipped in the package; the dashboard API can add and tighten red lines but refuses to weaken them (`409`); red lines from nested workspaces are unioned, never shadowed; every decision also goes to a hash-chained journal outside the repo; comments made in the dashboard are signed, and unsigned ones are shown to the agent as unverified.
- MCP-aware red lines: `mcp-actions` (send, post, push, merge, delete, pay and similar tool names on any server, plus changes other people see: calendar invites, shared docs, permissions; drafts stay allowed), `email-send` and `payments` (mail and payment servers and CLIs), `publish-deploy` (`npm publish`, `gh pr merge`, `vercel --prod` and others), `infra-destructive`, `db-destructive` and `protect-path` (deleting, moving or overwriting files under a glob). `init` lists the MCP servers it finds.
- `flowrail audit`: replays your recent Claude Code transcripts for the project through the current red lines and lists what would have been held or asked, minus what the `deny` and `ask` rules in your `settings.json` would have caught anyway. Local and read-only, no model call. Also on the Red lines page. `--demo` runs it over bundled fictional sessions.
- `flowrail redlines verify`: probes every red line with calls it must hold and calls it must allow, including the commands and paths your own rules quote, and ends with a one-line legend. `init` runs it at the end.
- Drift detection: a change to `red-lines.json` or `config.json` that flowrail did not make or the human did not approve makes every tool call ask until `flowrail redlines accept` is run in the human's own terminal; meanwhile the last accepted red lines still apply, so a blocked call stays blocked.
- Honest guard state: the CLI, the API and the dashboard share one check, and a guard that is missing, changed or not called shows every hooked red line as "not enforced".
- `flowrail init`: the guard alone, with no `CLAUDE.md` block. `flowrail-room init`: the guard plus the control room and a two-line `CLAUDE.md` block. Both detect an existing setup, preview every change, list every rule found in `CLAUDE.md` and `AGENTS.md` as covered, partial or not covered (probing the commands and paths the rule quotes, and naming what is not held), list the lines they skipped, and write uncovered rules as declared-only lines. Without a terminal and without `--yes`, it shows the plan and changes nothing.
- Eighteen red-line recipes (`flowrail redlines add --list`, also in `packages/flowrail/examples/red-lines/`) and a tester (`flowrail redlines test`) that never writes to the log and works without a workspace.
- Local dashboard on `127.0.0.1:4747`: overview with a Today card, board, document viewer with comments, knowledge graph, memory, red lines with plain-English summaries, routines, workflows, team, artifacts, security and settings. Every API call needs a per-launch token; red-line changes made in the dashboard are logged and shown.
- `flowrail-room today` and `GET /api/today`: what happened in the repo since midnight.
- Board with fixed-length sprints and rollover of unfinished tasks. `flowrail-room task` files into the current sprint.
- Comments on Markdown documents that agents pick up at session start, act on and resolve.
- Memory store and deterministic recall (`flowrail-room remember`, `flowrail-room recall`), with no model call.
- Routines on launchd (macOS) and crontab (Linux), run headless with read-only tools. Command routines are file-only, and `flowrail-room routines install` shows each command before scheduling it.
- Agent-written reports served in a sandbox with `connect-src 'none'`.
- Hold counts come from real sessions: hook calls without a session are marked as probes and not counted. Commands in the log are redacted (URL credentials, tokens, keys) and paths shown relative to the project.
- `flowrail doctor`, `flowrail hooks`, `flowrail upgrade`, `flowrail uninstall`, `flowrail-room demo`, `flowrail-room status`.

[0.1.0]: https://github.com/FinalAngel/flowrail/releases/tag/v0.1.0
