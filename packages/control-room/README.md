# @finalangel/flowrail-room

A local dashboard for the [`flowrail`](https://www.npmjs.com/package/flowrail) guard: red lines, the audit of your past sessions, comments your agent acts on, and an optional board. The guard works without it.

![The Control Room's Red lines page: the Try it box showing git push --force origin main held, and the audit panel.](https://raw.githubusercontent.com/FinalAngel/flowrail/main/assets/hero.png)

```sh
npx @finalangel/flowrail-room demo   # look around a sample workspace in a temp folder
npx @finalangel/flowrail-room init   # the guard plus the control room files
npx @finalangel/flowrail-room        # the dashboard on http://127.0.0.1:4747
```

- **Red lines**: each rule in plain English with its held count, a Try it box, the Verify table and an audit of your recent sessions. It warns when the rules were changed outside flowrail.
- **Comments as instructions**: select a passage in any Markdown file and comment on it; the next Claude Code session receives the open comments through the `SessionStart` hook. Comments are signed; one written into the folder by anything else is shown as unverified.
- **Board and memory**: sprints in `flowrail/board.json` (`npx @finalangel/flowrail-room task "…"`), one fact per file in `flowrail/memory/` (`npx @finalangel/flowrail-room recall "…"`, no model call).
- **Today and routines**: what happened in the repo since midnight, and scheduled report-only runs on launchd or cron.

It listens on `127.0.0.1` only, makes no outbound connections, and keeps everything in `flowrail/` (committed) and `.flowrail/` (per machine). The API can add and tighten red lines, never weaken them. `init` adds a two-line block to `CLAUDE.md`; the guard alone adds none. `npx @finalangel/flowrail-room --help` lists the commands; guard commands stay `npx flowrail …`.

Docs: https://github.com/FinalAngel/flowrail. MIT.
