# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**, or go to <https://github.com/FinalAngel/flowrail/security/advisories/new>. Do not open a public issue.

Include what you found, how to reproduce it, and what an attacker could do with it. The maintainers aim to acknowledge reports within a week. Fixes are released as a patch version and credited in the changelog unless you prefer otherwise.

In scope: anything that lets a party other than the local user read or change files through flowrail, bypass the dashboard's host, token, header or path checks, escape the artifact sandbox, make the guard allow a call it should have held, or switch the guard off without a held step (see [docs/tamper-model.md](docs/tamper-model.md)). A command that gets past a built-in matcher is welcome as a report too, though for a single case a pull request that adds a failing `HOLD` line to [test/corpus/](packages/flowrail/test/corpus/) is quicker.

Out of scope: the known gaps listed in [docs/red-lines.md](docs/red-lines.md#what-a-red-line-does-not-hold) and marked `gap` in the tamper model, and attacks that require already running code as the local user outside a Claude Code session.

## Threat model in brief

flowrail runs as your user, on your machine. It defends three things:

1. **Your rules against the agent.** Red lines run in Claude Code's `PreToolUse` hook, outside the model, before the tool executes. The hook runs a guard vendored into the repo (`.claude/flowrail/guard/`, plain Node, no dependencies), so it holds in a fresh clone with no `npm install`. The hook command in `settings.json` checks every guard file against `manifest.json` and the manifest against a hash written into the command before it runs anything: a guard that was deleted, emptied, garbled, edited (even with its manifest rewritten to match), or a missing `node`, makes the command exit 2 and Claude Code blocks the call. It fails closed. The self-protection line `protect-flowrail` is compiled into the guard and cannot be removed: it asks before the agent changes the red lines, the guard, the hooks (and the scripts your own hooks run), `.git/config`, `.git/hooks`, `.mcp.json`, the log, the managed block in `CLAUDE.md`, your shell startup files, `~/.gitconfig`, `~/.ssh/config` and Claude Code's user settings (in `~/.claude` or `$CLAUDE_CONFIG_DIR`), or writes `"disableAllHooks": true` into any file, whether it names them or reaches them through a glob, a loop, a file list piped into `xargs` or a copied tree; before it sets git configuration or environment that runs programs (`core.hooksPath`, `core.fsmonitor`, aliases, `GIT_SSH_COMMAND` …); and before it reads the machine-local key and journal. Paths are compared with symlinks resolved, for the project too, so a symlinked spelling of the project or a link into a protected folder is held the same. Any change to `red-lines.json` or `config.json` that flowrail did not make or you did not approve (an archive extracted over them, a patch, a stash pop) is detected on the next tool call: every call asks until you run `npx flowrail redlines accept` in your own terminal, and a call the last accepted red lines block stays blocked. `flowrail doctor`, `status` and the dashboard verify the guard's files by hash against the package.
2. **The dashboard against other websites, other hosts and the agent.** The server binds `127.0.0.1` only. It refuses a `Host` header that is not its own (DNS rebinding) and any foreign `Origin`. Every API call needs a random per-launch token; every write also needs an `X-Flowrail: 1` header (CSRF). Over the API, red lines can be added or tightened, never weakened (409). Command routines cannot be created or changed over HTTP, and there is no endpoint that starts Claude with a free-form prompt. Every red-line change is logged in the repo and in a hash-chained journal outside it.
3. **Your secrets against the dashboard.** Every path passes one gate that refuses absolute paths, `..`, symlinks out of the repo, hard links, `.git/`, `node_modules/`, `private/` folders and names that look like secrets. A symlink is judged by what it points at. Writes are limited to `.md` and `.txt`. Deletes move files to a trash folder.

## Honest limits

- **A red line is a seatbelt, not a jail.** The guard parses the command Claude hands to a tool: wrappers, quotes, `sh -c`, `eval`, `find -exec`, process substitution, globs, `for` loops and file lists piped into `xargs`, abbreviated git options, git aliases (including those already in your git config), inline `python -c` strings, heredocs fed to a shell, and scripts that name the guard's files. A script whose effect does not show in its text, encoded commands, or a tool you wrote no rule for can still do what a rule was meant to stop.
- **The integrity check runs once per call, at the start.** A process the agent started earlier (a step you approved) could swap a guard file in the milliseconds between the check and the import.
- **Some rule changes are detected, not prevented.** A writer the guard does not recognize (a compiled program, `git stash pop`, a merge) can still rewrite `red-lines.json`; the next tool call notices and asks until you review it. The write itself happened.
- **Some actions are not visible by name.** An MCP tool called `run` or `execute_sql` says nothing about what it does; `ask-before-mcp-actions` holds tools named for sending, publishing, merging, deleting, deploying and paying, and tools that change what other people see (calendar events that send invites, shared docs, permissions, comments). Creating an issue in a tracker is not held.
- **The dashboard token can be read by any process running as you.** The guard asks before the agent calls the dashboard's port or writes or runs a script that does, and the API refuses to weaken a red line even with the token.
- **Artifacts can navigate their own frame.** A report cannot fetch, open windows or read the dashboard, but a script in it can navigate its frame with data in the URL; the only data it has is what the report contains.
- **flowrail does not sandbox Claude Code.** Anything running as your user can read your files without going through flowrail.
- **Secret checks match names and high-confidence formats.** A secret with a custom format in a file with an ordinary name is not recognized.

The full model is in [docs/security.md](docs/security.md); every tamper path and its status is in [docs/tamper-model.md](docs/tamper-model.md).

## Supported versions

Security fixes go into the latest minor release.
