# FAQ

## Does flowrail send my data anywhere?

No. The flowrail server listens on `127.0.0.1` and makes no outbound connections. There is no telemetry, no account and no update check. The dashboard's Content Security Policy (`connect-src 'self'`) stops the page itself from contacting any other host, and reports written by agents open in a sandbox with `connect-src 'none'`, so a report cannot send anything anywhere. You can confirm both in your browser's network panel.

The CLI starts `git`, `gh` and `claude` when a command needs them. Those tools talk to their own services as usual. Routines that run Claude send their prompt to Anthropic, because that is what running Claude does.

## Can Claude get around a red line?

Yes, if it tries hard enough. A red line is a seatbelt, not a jail. The hook parses the command Claude hands to a tool, so it holds the direct form of an action and the variants agents actually type (`git -C . push`, `git pu\sh`, `sh -c "git push"`, `git push -uf`, `rm -rf ${HOME}` and hundreds more in the [public probe corpus](../packages/flowrail/test/corpus/)). It does not see what a script on disk does, and it does not follow variables, encodings or aliases set in an earlier call. [red-lines.md](red-lines.md#what-a-red-line-does-not-hold) lists the gaps, and each one is a `GAP` line in the corpus.

In practice the rule is doing its job when it catches the step an agent takes on the way to doing what you asked. For anything where one mistake is expensive, add a control that does not depend on the agent at all, such as branch protection or credentials the agent does not have.

## Can the agent just switch the red lines off?

Not without asking you. `protect-flowrail` is compiled into the guard and always on, whatever `red-lines.json` says. It asks before an agent edits the red lines, `flowrail/config.json`, `flowrail/routines.json`, `.claude/settings*.json`, the guard in `.claude/flowrail/`, `.git/config`, `.git/hooks/`, `.mcp.json` or the flowrail block in `CLAUDE.md`, from any write tool or shell writer; before it runs `flowrail uninstall` or `flowrail hooks uninstall`; and before it calls the dashboard's API with `curl` and friends. A script it writes that names those files is checked when it is written and again when it runs. The dashboard's API only adds and tightens red lines; weakening one over HTTP is refused with `409`. [tamper-model.md](tamper-model.md) lists every path we know and its status.

## Can the agent erase what it did, or fake a comment from me?

Not quietly. Every hold is written to `.flowrail/redlines.log` and to a hash-chained journal outside the repo; if the log loses or changes a line, `flowrail doctor`, `flowrail-room status` and the dashboard say **Audit log edited**. Comments you add in the dashboard are signed with a key that lives outside the repo, and Claude is only told to act on signed ones. A comment the agent writes into `.flowrail/comments/` itself shows as unverified. Both live in your user account, so code running as you could still rewrite them; they turn a silent edit into a visible one.

## What would flowrail have caught in my last month?

Run `npx flowrail audit`. It replays the tool calls from your recent Claude Code transcripts for this project through your current red lines and lists what would have been held or asked about. Local and read-only: nothing leaves the machine and no model is called.

## What happens when the hook itself breaks?

Inside a flowrail workspace it fails closed. A `red-lines.json` that does not parse, a regex that does not compile, or hook input it cannot read turns every affected call into an `ask` with the reason, and prints the same line to stderr. If the guard itself is gone, emptied, garbled or changed (even together with its manifest), or `node` is missing, the hook command exits with code 2, which Claude Code treats as a block: every tool call is refused with a message that says to run `npx flowrail upgrade`. `flowrail doctor`, `flowrail status`, `flowrail-room status` and the dashboard also show every hooked red line as "Not enforced".

## How is this different from a hook I write myself?

A hand-rolled hook is usually `grep -q 'git push'` over the whole command. It misses `git -C . push`, `git pu\sh` and `git clean --force -d`, and it blocks `grep -r "git push" docs`. The [README](../README.md#why-not-a-grep-hook) runs a typical 20-line hook against probes from the corpus. `flowrail init` merges its hooks into the `settings.json` you already have and keeps your own hooks.

## Then how is a red line better than a line in CLAUDE.md?

A line in `CLAUDE.md` is text the model reads. It works most of the time, and it can be forgotten in a long session, lost when context is compacted, or outweighed by a later instruction. A red line is checked by code before the tool runs, every time, whatever is in the context. When it fires, you find out, and the log shows how often it has.

## Is it safe to run the dashboard?

It is designed to be. It binds to loopback only and refuses requests with an unexpected `Host` header (DNS rebinding) or a foreign `Origin`. Every API call needs a random token made fresh each time the server starts and handed only to the page, and every write also needs a custom header. It refuses paths that look like secrets, including through symlinks, and serves agent-written HTML in a sandbox. Command routines cannot be created over the API, red-line changes made in the dashboard are logged and shown on it, and deletes go to a trash folder.

The residual risk: a process running as you can load the page and read the token. `protect-flowrail` asks before the agent does that with `curl`, `wget`, `nc` or an inline script; a script on disk is out of its reach. The details are in [security.md](security.md) and [SECURITY.md](../SECURITY.md).

## Does it work without Claude Code?

Mostly. The dashboard, board, document viewer, comments, memory, recall, workflows and `flowrail check` read and write plain files and work with any agent, or with none. The hooks that enforce red lines before a tool call, and the session-start briefing, need Claude Code. Adapters for other agent CLIs are planned, not built yet; [extending.md](extending.md#adapters-for-other-agent-clis) sketches the interface, and contributions are welcome.

## Does memory use a model or embeddings?

No. `flowrail-room recall` ranks memories and document sections by keyword overlap, with light stemming and a short list of synonyms. It is deterministic, instant and free, and it finds words, not meanings. Write memories with the words you will search for.

## Why zero dependencies?

A tool that sits in front of every command your agent runs should be small enough to read. flowrail is plain JavaScript on Node's standard library. Installing it installs nothing else, and there is no build step between the source in this repo and what runs on your machine.

## Will it mess up my repo?

`flowrail init` shows every change before making it and asks. It adds the guard in `.claude/flowrail/guard/`, `flowrail/config.json`, `flowrail/red-lines.json`, a `.flowrail/` line in `.gitignore` and hook entries in `.claude/settings.json`. It does not touch `package.json` and installs nothing with npm. `flowrail-room init` (the optional `@finalangel/flowrail-room` package) adds the control room on top: the rest of `flowrail/` and a two-line marked block in `CLAUDE.md`. Both keep your existing hooks and never overwrite an existing file.

`flowrail uninstall` removes the guard, its hooks and the `CLAUDE.md` block, again with a preview. It leaves `flowrail/` in place, because those are your tasks, memories and rules; delete the folder yourself if you want them gone.

## What should I commit?

Commit `.claude/flowrail/guard/`, `.claude/settings.json` and `flowrail/`. They are meant to be reviewed and shared: your guard, rules, board and memories travel with the repo, and a teammate who clones it is guarded before any `npm install`. `.flowrail/` holds per-machine state (comments, logs, trash) and is gitignored.

## Does it work on Windows?

Best effort. The CLI, dashboard and hooks are plain Node and should work. Routines are installed with launchd on macOS and crontab on Linux; on Windows, `flowrail-room routines install` prints what to set up in Task Scheduler. Reports from Windows users are welcome.

## Can several people use one workspace?

The committed files merge like any other files in git. The board is one JSON file, so two people moving tasks at once can conflict; the conflict is small and readable. Comments are per machine and do not travel.

## Why the name?

The mark is a path running between two rails: your agent keeps its flow, and the red lines are the rails it stays between.
