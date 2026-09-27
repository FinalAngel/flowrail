# CLI reference

flowrail ships two command-line tools:

- `flowrail` (the `flowrail` package) is the guard: setup, red lines, checks and the audit. Run it as `npx flowrail <command>`.
- `flowrail-room` (the optional `@finalangel/flowrail-room` package) is the control room: the dashboard, board, comments, memory and routines. Run it as `npx @finalangel/flowrail-room <command>`, or `flowrail-room <command>` once it is installed. It also runs every guard command. `flowrail <command>` hands a control room command to `flowrail-room` when it is installed, and otherwise prints how to start it.

Only people run these: the guard that enforces red lines is copied into the repo and runs with plain `node`, so nothing security-relevant depends on the npm packages. Commands find the workspace by walking up from the current directory until they reach `flowrail/config.json`.

Output is short and plain. Color is used only when stdout is a terminal. Commands marked `--json` print machine-readable output for scripts and agents.

Any command that changes a file outside `flowrail/` or `.flowrail/` (`.claude/settings.json`, `.claude/flowrail/guard/`, `CLAUDE.md`, `AGENTS.md`, `.gitignore`) prints the change and asks first. `--yes` (or `-y`) answers yes. Without a terminal to ask in and without `--yes`, nothing is changed and the command exits 2.

Set `FLOWRAIL_DEBUG=1` to print a stack trace when a command fails.

When a task is filed from inside a Claude Code session (the `CLAUDECODE` environment variable is set) or with `--agent`, it is recorded as `createdBy: "agent"` and the board tags it "Filed by agent". Notes and resolved comments are signed `agent` the same way, else `you`.

## Dashboard

### `flowrail-room` / `flowrail-room start`

Starts the dashboard on `http://127.0.0.1:4747` and opens it in your browser.

| Option | Meaning |
|---|---|
| `--port N` | Use port `N`. Without it: `port` from `flowrail/config.json`, else 4747. If the port is busy, flowrail tries the next 10 and says which one it took. |
| `--no-open` | Do not open a browser. |

### `flowrail-room demo`

Creates a throwaway workspace at `flowrail-demo` in your system's temp directory (replacing the previous demo there), seeds it with an example project ("Paper Plane", a small note app), starts the dashboard on it and prints the path. Nothing in your current repo is touched. The dashboard shows a banner while you are in it. Takes `--port N` and `--no-open` like `flowrail-room start`.

## Setup

### `flowrail init`

The guard on its own (`flowrail guard init` is the same command): copies the guard into `.claude/flowrail/guard/`, writes `flowrail/config.json` (only `name` and `port`: the port is how the guard recognizes calls to a dashboard's API) and `flowrail/red-lines.json` (the starter red lines plus the rules it finds in your `CLAUDE.md`), adds `.flowrail/` to `.gitignore`, and merges four hooks into `.claude/settings.json`. No `CLAUDE.md` block (the hooks need no instructions), no board, docs, memory or starter files. It never runs npm and never touches `package.json`. It ends by running `flowrail redlines verify` and prints the table, for example "Verified: 8 rules, 30 probes held, 20 allowed as expected."; if a red line does not hold one of its probes, init exits 1.

It first reports what it found, then lists every file it will add or change, then asks:

```text
Found  git repo (main), CLAUDE.md with 12 rules, 3 agents in .claude/agents, 2 skills

MCP servers  github, gmail. Ask before their send, post, push, merge, delete and pay tools? [Y/n]
```

MCP servers come from the project: `.mcp.json`, this project's entry in `~/.claude.json` (local scope) and `enabledMcpjsonServers` in `.claude/settings*.json`. User-scope servers every project sees are left out. The answer keeps or drops the starter line `ask-before-mcp-actions`.

It reads `CLAUDE.md` and `AGENTS.md` for rules ("never ...", "do not ...", "always ...", "ask before ...") and, where one matches a recipe that is not a starter, offers to enforce it:

```text
You wrote "Do not deploy without approval". Enforce it as no-deploy-without-asking (ask)? [Y/n]
You wrote "Don't delete anything in content/". Enforce it as protect-path-content (block)? [Y/n]
```

The severity in the question is the one written to the file and the one the hook uses. It follows the rule's wording: "without my OK", "without asking", "on your own", "ask me" ask; "never", "do not", "don't" without such a qualifier block (so "Never run `terraform destroy` ever" blocks). The six starters keep their own severity.

When a rule quotes a command or names a path that the chosen recipe does not hold, it offers a red line for exactly that, with the severity the wording asks for. A quoted command becomes a [`command`](red-lines.md#command) line matched on argv (the flags in any order, long or short: `git commit -nm fix` is `git commit --no-verify`); a named path becomes a `protect-path` line, with `"edits": true` when the rule says touch, edit, modify or change (then `sed -i`, `>>`, `tee -a`, `perl -pi`, `truncate`, `cp`/`mv` over it and `Edit` are held too). A rule that says what to do rather than what not to do ("Always run `pnpm test`", "Only use ...") gets no red line for what it quotes: it is written as declared only.

```text
Red lines for what your rules quote
  You wrote "Never run migrations against prod (`npm run db:migrate:prod`)". Add cmd-npm-run-db-migrate-prod (block): Never run npm run db:migrate:prod? [Y/n]
  You wrote "Do not touch anything in infra/terraform/". Add protect-path-infra-terraform (block): Never change, move or overwrite infra/terraform/? [Y/n]
```

The same wording sets an accepted recipe's severity: "Never issue Stripe refunds on your own" adds `no-payments` as `ask`, not `block`. A rule about calendar events, invites, meetings or Notion pages ("Don't create calendar events without asking") is covered by the starter `ask-before-mcp-actions`. Two rules that need the same builtin (`no-publish-without-asking` and `publish-deploy`) become one line at the stronger severity, and a glob is kept as written (`src/generated/**`).

Then it lists **every** rule it found with a verdict, and says which list items it skipped because they are not rules:

```text
Rules in your own files (3)
  covered      "Never push without asking"  CLAUDE.md
               no-push-without-asking: Asks before any git push (...)
  not covered  "Never run migrations against prod"  CLAUDE.md
               rule-never-run-migrations-against-prod: no recipe holds this; kept as a declared-only red line so it shows up on the dashboard
  partial      "Do not edit .env"  CLAUDE.md
               no-secrets-in-repo: Blocks writing .env files (...). Not held: ...
  Skipped 1 line that isn't a rule: "Use British English"
```

`covered` means red lines with a hook hold what the rule says, **including every command the rule quotes and every path it names**: those are run as probes against the chosen recipe, and whatever it does not hold gets the red line offered above (stored with `"probes"` on the line, so `flowrail redlines verify` keeps checking them); decline one and the rule is `partial`, with "Not held: `npm run db:migrate:prod`". Or your own Claude Code permissions already do it ("covered by your .claude/settings.json permissions.deny: Bash(terraform apply:*)": `permissions.deny` and `permissions.ask` in `.claude/settings.json` and `settings.local.json` are read). A recipe counts only when it matches the rule's intent, the thing that may not happen and what it happens to: "Use pnpm, not npm" is `prefer-pnpm`, "Always run pnpm test before committing" is not; `protect-migrations` guards editing old migrations, so "never run migrations against prod" is not covered by it. Folder names lose trailing punctuation ("Do not delete anything in content/." protects `content/**`). `partial` says what is held and what is not. `not covered` rules are written into `flowrail/red-lines.json` as declared-only lines (ids like `rule-always-write-tests`, the rule's words cut at 40 characters on a word boundary), so the dashboard shows them instead of letting them vanish. The verify table at the end shows each armed line holding its probes; a generated `command` line counts as covered only when its variants (flags reordered, the short form bundled, `sudo` in front) hold too.

It also offers starters for what the repo shows, with the evidence: `infra-destructive` (kubectl, terraform, aws, gcloud, helm, pulumi; `*.tf` up to three folders deep, `k8s/`, `helm/`, `charts/`), `db-destructive` (psql, mysql, `DATABASE_URL` in `.env.example`, `prisma/schema.prisma`), `publish-deploy` (`gh pr merge` or `gh release create` in scripts or CI, vercel, fly, a `Dockerfile`, a deploy step in `.github/workflows`, a deploy or release script, a package.json with `publishConfig` or `"private": false`), and, when you keep the MCP line, `no-emails-without-signoff` for a mail MCP server and `no-payments` for a payment one in the project's MCP config. It looks at `package.json`, `Makefile`, `justfile`, `.github/workflows/*`, `.env.example`, `docker-compose.yml` and files like `*.tf`, `fly.toml`, `vercel.json`. Programs on your `PATH` and user-scope MCP servers are not evidence: a three-line project gets the starters and the rules it wrote, nothing more. A starter whose builtin a line already runs is not offered again.

**A folder path used before.** The machine-local journal and accepted snapshots are keyed by the folder's real path. When `init` runs in a folder with no `.flowrail/` whose path this machine has state for (a deleted project, a fresh clone in the same place), it moves that state aside (`<id>.<time>.old.jsonl`, `.old.accepted.json`), starts a new journal with an `epoch` entry and says so, instead of reporting "Rules changed outside flowrail" and "Audit log edited". `init` creates `.flowrail/` so a later `init` keeps the journal. It never does this with `CLAUDECODE` set (inside a Claude Code session), where it could launder drift.

It never overwrites a file that already exists, so running it twice is safe. The starter red lines are `no-push-without-asking`, `no-destructive-git`, `no-secrets-in-repo`, `no-rm-rf-outside-project`, `protect-flowrail` and `ask-before-mcp-actions`. `protect-flowrail` is also built into the guard and active even if you delete it from the file.

At the end it runs `flowrail audit`: what these red lines would have held in your last 30 days of Claude Code sessions, read locally from your transcripts.

Without a terminal and without `--yes`, init says so on its second line ("Non-interactive: showing the plan. Re-run with --yes to apply."), prints the plan and exits 2.

| Option | Meaning |
|---|---|
| `--yes` | Do not ask. |
| `--diff` | Show the full JSON diff for `.claude/settings.json` instead of the list of added hooks. |

### `flowrail-room init`

The guard plus the control room: everything `flowrail init` does, plus starter content in `flowrail/` (a board with four onboarding tasks, a welcome doc and artifact, a workflow, a memory, a disabled routine) and a two-line marked block in `CLAUDE.md` that tells future sessions to stop and ask when a red line holds, and where reports go. Takes the same options as `flowrail init`, plus:

| Option | Meaning |
|---|---|
| `--agents-md` | Also add the block to `AGENTS.md`, creating it if needed. Without the flag, `AGENTS.md` gets the block only if it already exists. |

### `flowrail doctor`

Checks the guard's setup and prints a fix for each problem: Node version, `git` and `claude` on the path (a warning at most), workspace found, `.claude/settings*.json` valid JSON, the guard's hooks installed and running the pinned integrity check (its line links to [the hook command, part by part](hooks.md#the-hook-command-part-by-part)), the guard's files matching their manifest and this flowrail, `red-lines.json` readable and valid with every hook compiling (0 lines of your own is a warning: only the floor is active), rules changed outside flowrail, `.flowrail/redlines.log` matching the machine-local journal, `.flowrail/` in `.gitignore`. Exit 1 if any check fails. `--json` for scripts.

### `flowrail status`

The guard on one screen: whether it is live (every guard file verified, hooks in place), red lines by state, rules changed outside flowrail, and what it held this week, by red line. Exit 1 when the guard is not live. `--json` for scripts. The control room's `flowrail-room status` (sprint, backlog, routines) is a separate command.

### `flowrail upgrade`

Restores `.claude/flowrail/guard/` from the running flowrail, replaces the hook commands (a new guard means a new pinned manifest hash) and the `PreToolUse` matcher and, where one exists, the `CLAUDE.md` and `AGENTS.md` block (between `<!-- flowrail:start -->` and `<!-- flowrail:end -->`) with the current version's. Previewed.

### `flowrail hooks install | uninstall | status`

Installs (the guard and its hooks, without the `CLAUDE.md` block), removes or reports the hooks (`status` is the default). `status` prints each event, whether the guard's files verify, the file and command, and exits 1 unless the guard is live. See [hooks.md](hooks.md).

### `flowrail uninstall`

Removes the guard, its hooks and, if the control room added them, the `CLAUDE.md` and `AGENTS.md` blocks. Previewed. It leaves `flowrail/` and `.flowrail/` in place and tells you so; delete them yourself if you want them gone. Scheduled routines stay scheduled until you run `flowrail-room routines uninstall`.

## Status

These and the sections down to Memory, plus Routines, are control room commands: `npx @finalangel/flowrail-room <command>` or `flowrail-room <command>`.

### `flowrail-room status`

One screen: the current sprint (done, in progress, in review), the backlog, open comments, red lines by state and how often they held this week, whether the hooks are live, not installed or broken, and failed routines. `--json` for scripts (`hooks` is `true` only when they are healthy; `hooksProblem` says why not).

```text
  Red lines  8 armed · held 1 time this week · hooks live
```

### `flowrail-room today`

What happened in this repo since local midnight (or in the last 24 hours, before 06:00), one line each, newest first: red lines held (one line per rule, with the last thing held), red-line changes made in the dashboard, tasks filed and moved (by you or an agent), comments resolved, new reports in `flowrail/artifacts/`, routine runs, memories stored and git commits. Read from files flowrail already keeps; no model, no network. `--json` prints the same shape as `GET /api/today`.

```text
Today since Sat 00:00
  14:02  held       no-push-without-asking held 2× (agent)  last: asked first, git push
  11:40  task       Moved T-0007 to Review (agent)
  09:12  commit     Fix sync conflict on paragraph delete  3f2a91c
```

## Board

### `flowrail-room task "<title>"`

Files a task and prints its id (`T-0042`).

| Option | Meaning |
|---|---|
| `--status S` | `Todo` (default), `In Progress`, `Review`, `Done` |
| `--priority P` | `P0` to `P3` (default `P2`) |
| `--assignee NAME` | who owns it, for example `claude` |
| `--sprint current\|next\|backlog\|YYYY-MM-DD` | where it goes (default `current`, so `flowrail-room tasks` shows it) |
| `--label a,b` | comma-separated labels |
| `--note "text"` | add a first note |
| `--agent` | record it as filed by an agent |
| `--json` | print the task as JSON |

### `flowrail-room task update <id> --status "In Progress"`

Changes a task. Takes the same options as `task`, plus `--title "..."`. Labels given here replace the old ones. A status change is recorded in `.flowrail/activity.log` (with who made it) for `flowrail-room today`.

### `flowrail-room task note <id> "text"`

Appends a note to a task, stamped with the time and who wrote it.

### `flowrail-room tasks`

Lists the current sprint's open tasks. An `*` after the assignee marks a task filed by an agent.

| Option | Meaning |
|---|---|
| `--all` | Include the backlog and finished tasks. |
| `--json` | Machine-readable. |

### `flowrail-room board export`

Writes the current sprint as one standalone HTML file: inline CSS in flowrail's colours, light and dark from the reader's system, no scripts and nothing fetched. `--backlog` adds the unscheduled tasks as a table; `--out file.html` picks the path (default `.flowrail/exports/board-<date>.html`). The CLI reads `flowrail/board.json`; a workspace whose board comes from a plugin store exports from code with `boardHtml(store.read())` from the room's `src/core/export.js`.

## Comments

### `flowrail-room comments`

Lists open comments: file, quoted passage, comment, id. `--json` for scripts. Agents run this at the start of a session (the session-start hook does it for them).

### `flowrail-room resolve <path> <id>`

Marks a comment resolved. `--note "..."` records what was done; the dashboard shows the note under the comment. `--json` prints the comment.

## Memory

### `flowrail-room remember "<fact>"`

Stores one fact as `flowrail/memory/<name>.md` and adds a line to `flowrail/memory/INDEX.md`.

| Option | Meaning |
|---|---|
| `--type T` | `user`, `feedback`, `project` or `reference` (required) |
| `--name slug` | file name (required) |
| `--why "..."` | why the fact matters |
| `--how "..."` | how to apply it |
| `--force` | overwrite an existing memory with the same name |
| `--json` | print the stored memory as JSON |

### `flowrail-room recall "<question>"`

Ranks memories and document headings against the question and prints the best matches with their source. It is keyword ranking (BM25-style) and calls no model, so the same question always gives the same answer. `--limit N` changes how many hits (default 5); `--json` for scripts.

## Red lines

### `flowrail redlines`

Lists your red lines with severity, state and how often each held this week. `--json` for scripts. The state is one of:

| State | Meaning |
|---|---|
| armed | has a hook, and the guard is live and verified. Held at runtime. |
| checked in CI | has a check but no hook. `flowrail check` enforces it; nothing holds it at runtime. |
| declared only | neither a hook nor a check yet. |
| not enforced | has a hook, but the hooks are missing, still call the old npm command, or the guard's files changed. The only red state. |

Under each line is its plain-English summary: what a builtin holds, or the line's `why`. `protect-flowrail` is listed as "built in, always on" even when the file leaves it out.

```text
  armed          ask    no-push-without-asking  held 1× this week
                        Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync, and git aliases that push)
```

Hook calls made without a Claude Code session (you piping JSON into the hook) are counted separately and never as holds.

### `flowrail redlines add <recipe>`

Appends a recipe (or a `.json` file holding one red line) to `flowrail/red-lines.json`, and logs the change like the dashboard does. `flowrail redlines add --list` prints the recipes:

`no-push-without-asking`, `no-destructive-git`, `no-secrets-in-repo`, `no-rm-rf-outside-project`, `protect-flowrail`, `ask-before-mcp-actions`, `no-deploy-without-asking`, `no-publish-without-asking`, `no-emails-without-signoff`, `no-payments`, `infra-destructive`, `no-drop-table`, `db-destructive`, `publish-deploy`, `no-prod-db`, `protect-migrations`, `protect-path`, `prefer-pnpm`. The same recipes ship as files in `packages/flowrail/examples/red-lines/`.

`protect-path` takes a glob: `flowrail redlines add protect-path --glob "content/**"` writes `protect-path-content`, which asks before anything under `content/` is deleted, moved or overwritten.

### `flowrail redlines verify`

Runs every red line against calls it must hold (positive probes) and calls it must allow (negative probes), in a throwaway folder, through the guard's own decision code. For example `protect-path-content` must hold `rm content/probe.md`, `echo x > content/probe.md`, a `Write` over `content/probe.md`, `mv content/probe.md /tmp/` and `rm -rf content`, and allow `ls content`, `cat content/probe.md` and an `Edit` of it. A line's own `"probes"` (the commands and paths your `CLAUDE.md` rule quoted, written by `init`) run too. Prints one row per line, a summary ("Verified: 8 rules, 30 probes held, 20 allowed as expected.") and a one-line legend ("held = dangerous examples stopped; allowed = harmless examples let through; block = never runs; ask = Claude Code asks you first"), names every probe that was not held, and exits 1 if any was not. Lines with a regex of your own and no `"probes"`, and declared-only lines, are listed as not probed. Without a workspace it verifies the starter red lines. `--json` for scripts, `--all` to print every probe. `flowrail init` runs it at the end.

### `flowrail redlines accept`

When something other than flowrail changed `flowrail/red-lines.json` or `flowrail/config.json` (an archive, a patch, a stash pop, an editor), the guard asks on every tool call until you review it. Run this in your own terminal: it shows the diff against the last accepted version, warns if it removes a line, lowers a severity or changes a hook, and asks `[y/N]`. It refuses when `CLAUDECODE` is set (inside a Claude Code session) or when stdin is not a terminal, and the floor asks before an agent runs it. To undo the change instead, restore the file (`git checkout -- flowrail/red-lines.json`).

### `flowrail redlines test "<command>"`

Shows what the pre-tool-use hook would decide for a Bash command, without running it, with the same red lines the hook uses (every workspace from the project to the current folder, plus the floor): the parsed commands, then the decision (`held (block)`, `held (ask first)`, `warn` or `allowed`), the red line and what it held. `--tool Write` (or `Edit`, `Read`, or any tool name) tests a file path instead. `--json` for scripts. It is a dry run: nothing is logged, so testing never counts as a hold. With no workspace (a fresh folder, `npx flowrail redlines test "git push --force"` before installing anything) it tests against the starter red lines and the built-in floor, and says so.

```text
$ flowrail redlines test "git -C . push"
normalized: "git push"
held (ask first)  flowrail red line no-push-without-asking: Never push without asking (git push). Pushing publishes work. A human decides when.
```

### `flowrail check`

Runs every red line's `check` over the repo, and, when `secret-files` is armed, scans every file for high-confidence secrets (AWS, GitHub, Slack, Stripe, Anthropic and OpenAI keys, Google API keys, private keys) the way the hook scans every Write and Edit. Prints each hit with file and line, secrets redacted. Exit 1 if any `block` severity check has a hit, else 0. Without a workspace it checks with the starter red lines. `--json` for scripts. Suitable for CI; see [red-lines.md](red-lines.md#in-ci).

### `flowrail audit`

Replays the tool calls in this project's recent Claude Code transcripts (`~/.claude/projects/`, or `$CLAUDE_CONFIG_DIR/projects`) through the red lines you have now, with the guard's own decision code, and prints what would have been held and asked. Read-only and local: it writes nothing and calls no model. `--days 30` (1 to 365), `--all` for every row, `--json` for scripts; output closed early (`--json | head`) is fine.

It also says what you already had: every held call is checked against the `permissions.deny` and `permissions.ask` rules in `.claude/settings.json`, `settings.local.json` and `~/.claude/settings.json` (`Bash(git push:*)`, `Read(./.env)`, `mcp__stripe`), and the listing shows only what flowrail adds ("Your settings.json permissions (2 deny/ask rules) would have caught 2; flowrail adds 6:"). PreToolUse hooks of your own are counted, not run. `--no-vs-settings` lists everything.

`--demo` replays a few fictional sessions bundled with flowrail (a made-up project, `/work/acme-shop`, whose `settings.json` denies `git push --force` and asks before `git push`) through the starter red lines, so you can see the output before you have transcripts of your own. It takes well under a second:

```text
$ npx flowrail audit --demo
Demo: fictional transcripts bundled with flowrail (a made-up project, /work/acme-shop, whose settings.json denies git push --force and asks before git push), replayed through the starter red lines.

Last 30 days: 20 tool calls in 3 sessions.
flowrail would have held 3 (2 no-destructive-git, 1 no-rm-rf-outside-project) and asked first on 5 (...).
Your settings.json permissions (2 deny/ask rules) would have caught 2; flowrail adds 6:

  held   Jun 8, 12:10    no-destructive-git        git reset --hard origin/main
  ...
held = blocked, it never runs; asked = Claude Code asks you first.
```

## Routines

### `flowrail-room routines install | uninstall | status`

Installs the enabled routines (`"enabled": true`) from `flowrail/routines.json` into the system scheduler (launchd on macOS, crontab on Linux), removes them, or reports their state (`status` is the default; `--json` for scripts). On other systems `install` prints what to schedule by hand.

`install` first lists every routine it will schedule, with the exact argv of each command routine, and asks (`[y/N]`). `--yes` skips the question; without a terminal and without `--yes` nothing is scheduled and it exits 2. A `routines.json` that arrived with a clone never installs silently. The dashboard can schedule claude routines, but refuses while an enabled command routine exists.

### `flowrail-room routines run <id>`

Runs one routine now and records the run in `.flowrail/runs/`. Exit 1 if the routine fails.

## Hooks

### `flowrail hook pre-tool-use | session-start | subagent`

The guard run from the installed package; the vendored `.claude/flowrail/guard/hook.mjs` that the hooks in `settings.json` run is the same code. See [hooks.md](hooks.md).

### `flowrail guard`

With no subcommand: the pre-tool-use hook run from the installed package, for a `settings.json` you maintain yourself. The command `init` writes (it checks the vendored guard against its manifest, then runs it) is the better choice. See [hooks.md](hooks.md#bring-your-own-settings).

## Other

### `flowrail room [args]`

Runs `flowrail-room` with the given arguments if `@finalangel/flowrail-room` is installed (in the project's `node_modules`, next to `flowrail`, or on the PATH); otherwise prints one line with the `npx @finalangel/flowrail-room …` command and exits 1. The control room's own commands (`flowrail start`, `demo`, `today`, `task`, `tasks`, `comments`, `resolve`, `remember`, `recall`, `routines`) are handed over the same way.

### `flowrail --version`, `flowrail help`

Print the version, or a summary of commands (`-v`, `-h` and `--help` work too). `flowrail-room --version` and `flowrail-room help` do the same for the control room.
