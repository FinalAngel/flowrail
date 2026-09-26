# Concepts

flowrail is two things. First, a hook that makes Claude Code respect your hard rules before a tool runs. Second, and optional, a set of conventions for keeping an agent's working state in your repo, with a CLI and a dashboard that read and write those files: the control room, a separate package (`@finalangel/flowrail-room`, command `flowrail-room`). This page explains the pieces and why they are shaped the way they are.

## The repo is the state

Everything flowrail knows lives in two folders at the root of your project.

`flowrail/` is committed. It holds the things you would want in a code review or on another machine: rules, tasks, memories, workflows, routines, reports. The guard on its own (`flowrail init`) writes only `config.json` and `red-lines.json`; the rest comes with the control room (`flowrail-room init`).

```text
flowrail/
  config.json        name, port, which modules are on, sprint length and start
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

## Team

The Team page lists the subagents defined in `.claude/agents/`, the skills, and the slash commands. The subagent hooks record when each agent starts and stops, so you can see who is working.

## What flowrail does not do

- It does not call a model on its own, except in routines and runs that you start.
- It does not run sessions in parallel or manage worktrees.
- It does not sync anything to a server.
- It does not replace your permission settings in Claude Code. Red lines add to them.
