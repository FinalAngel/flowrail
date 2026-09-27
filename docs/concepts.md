# Concepts

flowrail is two things. First, a hook that makes Claude Code respect your hard rules before a tool runs. Second, and optional, a set of conventions for keeping an agent's working state in your repo, with a CLI and a dashboard that read and write those files: the control room, a separate package (`@finalangel/flowrail-room`, command `flowrail-room`). This page explains the pieces and why they are shaped the way they are.

## The repo is the state

Everything flowrail knows lives in two folders at the root of your project.

`flowrail/` is committed. It holds the things you would want in a code review or on another machine: rules, tasks, memories, workflows, routines, reports. The guard on its own (`flowrail init`) writes only `config.json` and `red-lines.json`; the rest comes with the control room (`flowrail-room init`).

```text
flowrail/
  config.json        name, port, which modules are on, sprint length and start, and the GitHub
                     repo whose assigned issues the board shows (read-only, optional)
  red-lines.json     your hard rules
  board.json         tasks for the current sprint, the next one, and the backlog
  memory/            one fact per Markdown file, plus INDEX.md
  workflows/         step-by-step procedures, in Markdown
  routines.json      scheduled agent runs
  artifacts/         HTML reports agents leave for you
  links.json         bookmarks shown on the dashboard
```

`.flowrail/` is gitignored. It holds what belongs to one machine:

```text
.flowrail/
  comments/            one JSON file per commented document
  runs/                one record and one log per run, plus routines.log
  redlines.log         every hold and every red-line change made in the dashboard, one JSON line each
  activity.log         task moves and who made them, for `flowrail-room today`
  check-results.json   the last `flowrail check` result
  agents/              subagent status written by the hooks
  trash/               everything the dashboard deleted, with a timestamp prefix
```

One more folder lives outside the repo, per user: `$XDG_STATE_HOME/flowrail/` (else `~/Library/Application Support/flowrail/` on macOS, `~/.local/state/flowrail/` elsewhere; `FLOWRAIL_STATE_DIR` overrides it).

```text
<state dir>/
  <project id>.jsonl           a hash-chained copy of every entry in .flowrail/redlines.log
  <project id>.accepted.json   the last accepted red-lines.json and config.json, for drift detection
  key                          the key that signs comments made in the dashboard (0600)
  ports.json                   the ports a running dashboard listens on
```

It exists because the agent works inside the repo. Every hook decision and every red-line change goes to `.flowrail/redlines.log` and to the journal, each journal entry carrying the SHA-256 of the one before it. `flowrail-room status` and the dashboard compare the two: a log line that was deleted or changed, a line the journal never wrote, or a broken chain shows as **Audit log edited** in Needs attention. Comments added in the dashboard are signed with the key; the session-start briefing gives Claude only signed comments as instructions and lists the rest as unverified. Neither is a vault: an agent that can run arbitrary code as you could rewrite both. They make a quiet edit visible, which is the point.

There is no database and no server-side state. The dashboard, the CLI and Claude all read the same files, so a change made in one shows up in the others, and `git diff` shows what any of them did. If you remove flowrail, the files stay and remain readable.

The formats are plain JSON and Markdown with front matter, and they do not mention Claude. Another agent, a script or a person with a text editor can work with them.

## Red lines

A red line is a rule you never want broken, written as data rather than prose. A sentence in `CLAUDE.md` is an instruction the model reads and will usually follow. A red line is checked by code before the action happens.

Each red line has up to three parts, which the dashboard draws as a chain:

- **Rule**: the words, a reason, a severity (`block`, `ask` or `warn`).
- **Check**: a pattern that `flowrail check` looks for in files, locally or in CI.
- **Hook**: a built-in matcher (`git-push`, `git-destructive`, `rm-dangerous`, `secret-files`, `flowrail-tamper`, `mcp-actions` and others, see [red-lines.md](red-lines.md#built-in-matchers)) or a regular expression that Claude Code's `PreToolUse` hook tests against each tool call. The builtins parse a shell command into argv and read its flags, so `git push -uf` and `git clean -nf` get the decisions you would expect.

Every red line is in exactly one of four states. The dashboard, `flowrail redlines`, `flowrail-room status` and the API (`state` on each line of `GET /api/redlines`) all use the same four.

| State | When | Shown as |
|---|---|---|
| `armed` | It has a hook, and the hooks are installed. Held at runtime. | "Armed", in green |
| `checked` | It has a check and no hook. `flowrail check` enforces it, locally or in CI, not at runtime. | "Checked in CI", neutral |
| `declared` | It has neither. A rule written down, not yet enforced. | "Declared only", amber |
| `not-enforced` | It has a hook, but the hooks are missing, or the program the hook command calls is gone. | "Not enforced", the one red state in the product |

A rule with both a hook and a check is `armed` or `not-enforced`, depending on the hooks; its check still runs in `flowrail check`.

Two properties matter as much as the matching. The hook fails closed: inside a workspace, a `red-lines.json` it cannot read or a regex that does not compile turns into an `ask`, never a silent allow. And the rules protect themselves: the starter line `protect-flowrail` asks before an agent edits the red lines, flowrail settings or Claude settings, uninstalls the hooks, or calls the dashboard's API.

When the hook stops something, flowrail records it as **held**, not as a violation. Usually the agent was doing what you asked, and the rule caught one step of it. Claude sees the reason, and more often than not it asks you or finds another way.

The details, including exactly what the hook can and cannot see, are in [red-lines.md](red-lines.md).

## Comments are instructions

Open any Markdown file in the dashboard, select a passage and leave a comment. The comment is stored in `.flowrail/comments/`, anchored to the quoted text.

At the start of each Claude Code session the session-start hook lists open comments and tells Claude to treat them as instructions. Claude reads the file, acts on the comment, and runs `flowrail-room resolve <path> <id> --note "..."`. You see the comment turn to "Resolved" with the note underneath.

This works well for the kind of instruction that is easier to point at than to describe: "this paragraph is out of date", "split this section", "turn this list into a table".

## The board

`flowrail/board.json` holds tasks with an id (`T-0001`), a status (`Todo`, `In Progress`, `Review`, `Done`), a priority (`P0` to `P3`), an assignee, labels and notes.

Sprints are fixed-length periods (14 days by default) counted from `sprintStart` in `config.json`. A task's `sprint` field is the start date of the sprint it belongs to; an empty string means the backlog. When a sprint has ended, the next read of the board moves its unfinished tasks into the current sprint, raises each one priority level, and adds a note saying so. Nothing is silently dropped, and work that keeps slipping gets louder.

Agents file tasks with `flowrail-room task "..."`, which puts them in the current sprint (`--sprint backlog` parks one). Those tasks record `createdBy: "agent"` and the board marks them "Filed by agent", so you can tell what you asked for from what Claude decided needed doing.

## Memory

A memory is one fact in one Markdown file under `flowrail/memory/`:

```markdown
---
name: release-branch
type: project
description: Releases are cut from the release branch, never from main.
created: 2026-01-12
---
Releases are cut from `release`, never from `main`.

Why: main carries unreviewed work between releases.
How to apply: when asked to prepare a release, check out `release` first. See [[changelog-format]].
```

There are four types. `user` is about you (preferences, role). `feedback` is a correction you gave an agent that should stick. `project` is a fact or decision about the work. `reference` points to where something lives.

`flowrail-room recall "question"` ranks memories and the sections of Markdown documents (split at headings) by keyword overlap, BM25 style, and prints the best matches with their file. It calls no model and sends nothing anywhere, so it is fast, free and repeatable. It also means recall matches words, not meaning. Light stemming and a short synonym list (deploy, release and ship, for example) close some of the gap, so "how do we ship" finds a memory that says "release", but not all of it. Write memories with the words you will search for.

## Workflows

A workflow is a Markdown file in `flowrail/workflows/` whose steps are headings:

```markdown
# Publish a release

## Step 1: Update the changelog
## Step 2: Run the tests
## Step 3: SIGN-OFF: a person reviews the diff
## Step 4: Tag and publish
```

A step whose heading contains `GATE` or `SIGN-OFF` is a human gate. The dashboard draws the workflow as a rail with gates as distinct nodes. A gate in a workflow is guidance that Claude reads; to enforce it, pair it with a red line on the action behind it (here, `npm publish`).

## Routines

A routine is an agent run on a schedule, defined in `flowrail/routines.json`:

```json
{
  "id": "weekly-review",
  "title": "Weekly review of open tasks",
  "schedule": { "every": "monday", "at": "07:00" },
  "run": { "type": "claude", "prompt": "Read flowrail/board.json and write a short report of what is stuck to flowrail/artifacts/." },
  "report": true
}
```

`every` is `hour`, `day`, `weekday` or a day name. `run` is either a Claude prompt, run headless with read-only tools plus writing into `flowrail/artifacts/` (see [security.md](security.md#headless-runs)), or a command (`{ "type": "command", "cmd": ["npm", "run", "report"] }`). Command routines are written in the file only; the dashboard API refuses to create or change them. `flowrail-room routines install` lists each command routine's argv and asks before handing the schedule to launchd on macOS or crontab on Linux, so a `routines.json` from a cloned repo never schedules anything silently. Each run is logged in `.flowrail/runs/`, and a failed run shows up on the dashboard until the next one succeeds.

## Today

`flowrail-room today`, `GET /api/today` and the Today card on the dashboard list what happened in the repo since midnight: red lines held, tasks filed and moved (by you or an agent), comments resolved, new artifacts, routine runs, memories stored and git commits. It reads files flowrail already keeps, and calls no model.

## Artifacts

An artifact is an HTML file an agent writes to `flowrail/artifacts/` for you to read: a report, a comparison, a chart. An optional sidecar `<name>.json` gives it a title, summary and tags. The dashboard lists them and opens them in a sandbox (see [security.md](security.md#artifacts)).

## The map

The Graph page shows the repo three ways. **Graph** is the link graph: docs, memories and automation joined by Markdown links, `[[wikilinks]]` and folders. **Rings** puts `CLAUDE.md` in the middle and draws everything else on rings at one steady rhythm: skills and commands, one marker per area, the documents grouped by area, routines and red lines, and artifacts on the outside. **Tree** is the folder hierarchy with counts.

Areas are the parts of your repo that have a router, a document that says what belongs to that part. Name them in `flowrail/config.json` (`"areas": [{ "name": "Sales", "router": "SALES.md" }]`), or in a table in `CLAUDE.md` whose rows link a router (`| Sales | [SALES.md](SALES.md) | ... |`). A file belongs to the area whose router names it or a folder above it.

## Library, areas and context

The **Library** lists every Markdown document with when it last changed (from git history, or the file time outside git) and whether it is fresh, aging or stale. The thresholds are `"staleDays": [30, 90]` in `flowrail/config.json`.

**Areas** group documents by who owns them. List them in `config.json`:

```json
"areas": [{ "name": "Product", "router": "docs/PRODUCT.md" }, { "name": "Engineering", "router": "docs/ENGINEERING.md" }]
```

or put a table in `CLAUDE.md` whose rows link one router file per area (`| Sales | [SALES.md](SALES.md) | leads, playbooks |`); `config.json` wins when both exist. A router is an ordinary Markdown page that names the files and folders of its area, as links, `code` or plain paths. A document belongs to the area whose router names it, or else names a folder above it; the longest folder wins. Agents read the same routers to find their way, so one file serves both.

**`nav`** regroups the sidebar, for example by department: `"nav": { "Product": ["board", "library"], "Engineering": ["workflows", "routines"] }` puts those pages in those groups, in that order, above the rest. Page ids are the ones in the page addresses; a plugin page's id is `<plugin>:<page>`.

**Context** is the reference shelf: one folder per source under `flowrail/context/` (or `"contextDir"`), each with an `index.md` whose frontmatter gives `title`, `source` and `summary`, plus any notes beside it.

**Links** are the bookmarks in `flowrail/links.json`. Web links open in a new tab, repo paths in Docs. A link's icon is an icon name (`"icon": "docs"`) or its own stroke-only `svg` on a 24px grid, which the server cuts down to plain shapes before the page draws it.

**The dashboard's layout** is yours to arrange: Edit layout in the header moves cards up, down or to the other column (drag works too), hides them, and Reset layout brings the default back. It is kept per browser.

**The add-context skill.** `flowrail-room init` offers `.claude/skills/add-context/SKILL.md` (never over a file you have): it tells an agent how to add a source to the Context library, short, cited and in its own words.

**Where things live.** Three more file-only settings point the room at folders a repo already has: `"docsRoots": ["docs", "README.md"]` limits what Docs, the Library, search and the map list, open and write to those folders and files (unset shows the whole repo, minus secrets and dot-folders); `"artifactsDir"`, `"linksFile"` and `"agentsDir"` (where the agent status files are) move artifacts, the link list and the Agents page's live state out of `flowrail/` and `.flowrail/`. A link file may also be `{ "categories": [{ "name", "links" }] }`.

`"brand": { "name": "Acme ops", "mono": "Acme" }` names the sidebar and the tab titles (the `mono` start of the name is set in the mono face).

**Reminders.** A date a document already carries in its frontmatter (`due: 2026-10-15`, `next_date: …`) shows under "Needs you" once it is overdue or due within a week, and on Today when it is due today or overdue. Choose the fields and the window with `"reminders": { "fields": ["due", "next_date", "renewal_date"], "within": 7 }`. Work that comes back every period is a duty: `"duties": [{ "name": "Monthly close", "every": "month", "due": 7 }, { "name": "VAT return", "every": "quarter", "due": 60 }]`. When a period ends its instance opens, named with the period ("Monthly close September 2026", "VAT return Q3/2026"), and turns overdue `due` days later; a Done task on the board whose title holds that name closes it. Only the last ended period shows unless the duty has `"from": "2026-01-01"`.

**Router lint.** With areas set, `flowrail check` also checks the routers: each under a page, every pointer in them resolving, every folder reachable from `CLAUDE.md` or a router. See [cli.md](cli.md#flowrail-check).

These settings are file-only: the dashboard's settings API cannot change them.

## Agents

The Agents page lists the people first, then the subagents defined in `.claude/agents/`, the skills, and the slash commands. The subagent hooks record when each agent starts and stops, so you can see who is working.

**People** are one Markdown file per person in `flowrail/people/` (or the folder `"people": { "dir": "team" }` names in `config.json`), with `name`, `role`, `email` and `links` in the frontmatter and a short bio as the first paragraph. A profile that keeps its facts in a two-column table instead (`| Role | COO |`, `| Work email | … |`, `| Time zone | CET |`) works too: `title` or the first heading names the person, the table supplies role and email, and its other rows show on the card. The card links to the file in Docs.

## Actions

An action is a command you start from the Runs page with a few inputs: record a meeting from its link, build a report for one client. Actions are listed in `flowrail/config.json` only:

```json
"actions": [{ "id": "record-meeting", "title": "Record a meeting", "cmd": ["node", "scripts/record.js", "--url", "{url}", "--kind", "{kind}"],
  "inputs": [{ "name": "url", "label": "Meeting link", "type": "url", "pattern": "^https://", "required": true },
             { "name": "kind", "type": "select", "options": ["sales", "general"] }] }]
```

Run opens a form for the inputs. Each `{name}` in `cmd` must be a whole argument; it is replaced by the checked value as one argument, so nothing reaches a shell and a value is never split or read as an option. Inputs are `text` (the default), `url` (http or https) or `select` (one of `options`), with `required`, `max` (characters, default 500) and `pattern` (a regular expression the value must match). A text or link value may not start with `-` or contain line breaks. The run is recorded on the Runs page like every other run, one at a time.

## What flowrail does not do

- It does not call a model on its own, except in routines and runs that you start.
- It does not run sessions in parallel or manage worktrees.
- It does not sync anything to a server.
- It does not replace your permission settings in Claude Code. Red lines add to them.

## Records

A records collection is a folder of Markdown files, one record per file, with its fields in the frontmatter: customers, beta testers, candidates, vendors, incidents. Each collection gets two pages, a table and a board, in the sidebar group you name (default **Records**). Configure them in `flowrail/config.json` (file-only; the settings API ignores it, and the server reads it at start):

```json
"records": [{
  "id": "customers", "title": "Customers", "dir": "records/customers", "group": "Sales",
  "status": { "field": "status", "values": ["lead", "talking", "trial", "won", "lost"], "board": ["talking", "trial", "won"], "tones": { "won": "accent", "lost": "muted" } },
  "columns": ["company", "contact", "region"], "filters": ["segment", "region"], "due": "next_date", "titleField": "company"
}]
```

The **table** (`#/records/customers`) shows a status bar, one filter row (search, status, a select per `filters` field, and a Due soon switch when `due` is set) and sortable columns; a row opens the file in Docs. The **board** (`#/records/customers/board`) has a column per `board` value (default: every value); a card's ‹ › set its status, which rewrites only that frontmatter line (the rest of the file stays byte for byte, and a file changed since the page loaded it is refused). A date in the `due` field puts a chip on the card: overdue in red with a red bar, today to three days out in amber, later quietly. `titleField` names the field used as a record's title (else `title`, the first heading, or the file name). `README.md` and `index.md` in the folder are not records, and files Docs will not serve (secrets, outside `docsRoots`) are skipped.

