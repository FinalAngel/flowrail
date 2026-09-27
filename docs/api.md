# HTTP API

The dashboard is a static page that talks to a small JSON API served by the same process. The API is there for the dashboard, and it is documented so that you can script against it, but it is local only and carries no stability promise before 1.0.

## Ground rules

- The server listens on `127.0.0.1` only, on port 4747 unless configured otherwise.
- Requests whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>` get `421`.
- **Every request under `/api/` needs the per-launch token**, or it gets `401` with `{ "error": "token" }`. The server makes a new random token each time it starts and puts it in the dashboard page as `<meta name="flowrail-token" content="…">`. Send it as the header `X-Flowrail-Token: <token>`; `GET /api/events` takes it as `?token=<token>` instead, because `EventSource` cannot send headers. The token is never written to disk or printed. `/`, `/ui/*` and `/artifacts/*` need no token.
- Every request that is not `GET` or `HEAD` must also carry the header `X-Flowrail: 1`, or it gets `403`. Any request with an `Origin` header other than the server's own gets `403`.
- Request bodies are JSON, capped at 1 MB (2.5 MB for `/api/docs/file`). A larger body gets `413`.
- Errors come back as `{ "error": "..." }` with a `4xx` or `5xx` status. A known path with the wrong method gets `405`.
- Mutations are sent as `POST` with an `_action` field in the JSON body.
- "Trash" never deletes: it moves the file to `.flowrail/trash/` with a timestamp prefix.

```sh
TOKEN=$(curl -s http://127.0.0.1:4747/ | sed -n 's/.*name="flowrail-token" content="\([0-9a-f]*\)".*/\1/p')
curl -s -H "X-Flowrail-Token: $TOKEN" http://127.0.0.1:4747/api/overview
curl -s -X POST http://127.0.0.1:4747/api/board \
  -H "X-Flowrail-Token: $TOKEN" -H 'X-Flowrail: 1' -H 'Content-Type: application/json' \
  -d '{"_action":"create","title":"Write the release notes","priority":"P2"}'
```

Inside a Claude Code session the `protect-flowrail` red line asks before commands like these, on purpose: the agent should use the CLI, and you should know when something talks to the dashboard. The reasons behind these rules are in [security.md](security.md).

## Endpoints

### Overview

`GET /api/overview`

```json
{
  "workspace": { "name": "paper-plane", "root": "/path/to/repo", "version": "0.1.0", "demo": false },
  "setup": { "steps": [{ "id": "hooks", "title": "Install hooks", "done": true, "hint": "npx flowrail hooks install" }], "done": 4, "total": 5, "dismissed": false },
  "attention": [{ "kind": "comment", "title": "...", "href": "#/docs?path=flowrail%2FWELCOME.md", "severity": "normal", "at": "2026-01-12T08:40:00.000Z" }],
  "counts": {
    "tasksOpen": 9, "inProgress": 2, "review": 1, "commentsOpen": 3, "redlinesHeldWeek": 4,
    "redlinesArmed": 4, "redlinesStates": { "armed": 4, "checked": 1, "declared": 1, "not-enforced": 0 },
    "redlinesTotal": 6, "routinesFailed": 1, "memories": 6
  },
  "sprint": { "index": 3, "start": "2026-01-05", "end": "2026-01-18", "label": "Sprint 3", "range": "5 Jan to 18 Jan", "total": 10, "done": 3, "inProgress": 2, "review": 1 },
  "hooks": { "installed": true, "healthy": true, "where": "settings.json", "command": "node -e '/*flowrail-guard*/…' pre-tool-use || { …; exit 2; }" },
  "journal": { "ok": true, "entries": 41, "problems": [] },
  "recent": { "artifacts": [], "runs": [], "redlineEvents": [] },
  "git": { "branch": "main", "dirty": 2, "ahead": null }
}
```

`hooks` is the one hook state every surface uses: `installed` (every flowrail hook event is present), `healthy` (installed, the settings parse, every hook is the pinned integrity check for the vendored guard, and the guard's files match their manifest and the hashes this flowrail ships), `where` (the settings file that holds the PreToolUse hook, or `null`), `command` (the PreToolUse command, or `null`), `guard` (`{ version, verified, changed }`, `changed` listing the guard files that differ), and `problem` (a sentence, present only when not healthy, for example "Guard files changed (hook.mjs). Run npx flowrail upgrade to restore"). Red-line states use `healthy`: when it is false every line with a hook is `not-enforced`.

`attention[].kind` is `hooks`, `redlines` (red-lines.json cannot be read), `audit` ("Audit log edited": `.flowrail/redlines.log` disagrees with the journal outside the repo, `high`; `detail` lists every problem), `redlines-changed`, `routine`, `check`, `comment` or `task`; `severity` is `high`, `warn` or `normal`. `redlines-changed` appears for seven days after the red lines were saved through this API, with a title like "Red lines changed at Jan 12 14:02 (3 removed)" (`high` when something was removed). `recent` lists hold up to five items each; `recent.redlineEvents` holds no probes. `git` is `null` outside a git repo, and `ahead` is `null` when the branch has no upstream. `redlinesStates` uses the [red line states](concepts.md#red-lines).

### Today

`GET /api/today` or `GET /api/today?since=2026-01-12T08:30:00.000Z`

```json
{
  "since": "2026-01-12T00:00:00.000Z",
  "items": [
    { "kind": "held", "title": "no-push-without-asking held 2×", "detail": "last: asked first, git push", "at": "2026-01-12T14:02:11.408Z", "href": "#/redlines", "by": "agent" },
    { "kind": "task", "title": "Moved T-0007 to Review", "detail": "Flaky test: sync/merge.test.js", "at": "2026-01-12T11:40:00.000Z", "href": "#/board?task=T-0007", "by": "agent" },
    { "kind": "commit", "title": "Fix sync conflict on paragraph delete", "detail": "3f2a91c", "at": "2026-01-12T09:12:00.000Z" }
  ],
  "counts": { "held": 2, "tasksMoved": 1, "tasksCreated": 0, "commentsResolved": 0, "artifacts": 0, "routines": 0, "commits": 1, "memories": 0 }
}
```

What happened in the repo since `since`: local midnight, or the last 24 hours when it is before 06:00. Pass `?since=` (any ISO time, clamped to the last 30 days) for "While you were away": the dashboard sends the time of your last visit. The starter tasks, memory and report that `init` writes carry `seed: true` and never appear here, so a fresh workspace starts with an empty Today. `items` is newest first, at most 50. `kind` is one of `held` (one item per red line, `by: "agent"`), `redlines-changed`, `task` (filed or moved; `by` is `agent` or `human`), `comment` (resolved), `artifact` (a new report), `routine` (a run), `commit` (from `git log --since`; none without git), or `memory` (stored or changed). `detail`, `href` and `by` are optional. `counts.held` counts holds, not rules. Task moves come from `.flowrail/activity.log`, which `flowrail-room task update` and the board write on every status change.

### Audit

`GET /api/audit?days=30`

```json
{
  "days": 30, "sessions": 12, "calls": 1284,
  "held": [{ "at": "2026-01-10T16:20:03.000Z", "tool": "Bash", "subject": "git push --force origin main", "line": "no-destructive-git", "severity": "block", "session": "4f0c2a91" }],
  "asked": [{ "at": "2026-01-11T09:02:44.000Z", "tool": "Read", "subject": ".env", "line": "no-secrets-in-repo", "severity": "ask", "session": "b81e0d37" }],
  "byLine": { "no-destructive-git": 1, "no-secrets-in-repo": 1 },
  "transcriptsDir": "/home/you/.claude/projects"
}
```

Replays the tool calls in this project's Claude Code transcripts from the last `days` days (1 to 365, default 30) through the current red lines, the same decision the hook makes. `held` is what would have been blocked, `asked` what would have needed your yes; both are newest first, with paths relative to the project and secrets redacted. Transcripts are read from `$CLAUDE_CONFIG_DIR/projects` (else `~/.claude/projects`), in the folder for this project and those for its subfolders; only `tool_use` blocks are parsed, in memory, and nothing is written. `note` explains an empty result (no transcripts, no calls in the window, unreadable red lines). `flowrail audit` prints the same.

### Config

| Method | Path | Does |
|---|---|---|
| GET | `/api/config` | `flowrail/config.json` with defaults filled in, plus `version`. |
| POST | `/api/config` | Validates and merges the fields you send (`name`, `port`, `sprintLength`, `sprintStart`, `setupDismissed`, `modules`) into `config.json`, and returns the result. |

`areas`, `nav`, `staleDays` and `contextDir` are read from the file only; `POST /api/config` ignores them.

`modules` has one boolean per module: `board`, `docs`, `knowledge`, `memory`, `redlines`, `routines`, `workflows`, `team`, `artifacts`.

### Board

`GET /api/board` returns `{ config: { sprintLength, current, next }, tasks: [...] }`, where `current` and `next` are `{ index, start, end, label, range }`. A task is `{ id, title, status, priority, sprint, assignee, labels, notes: [{ at, by, text }], createdBy, created, updated }`.

Reading the board also rolls over unfinished work: a task whose sprint has ended moves to the current sprint, its priority goes up one level (P3 to P2, and so on), and it gets the note "rolled over from <label>".

`POST /api/board` with `_action`:

| `_action` | Body |
|---|---|
| `create` | `title`, and optionally `status`, `priority`, `sprint`, `assignee`, `labels`, `createdBy` (`"agent"` or `"human"`, the default) |
| `update` | `id` and the fields to change |
| `note` | `id`, `text`, optionally `by` (default `"you"`) |
| `trash` | `id` |

`GET /api/board/issues` (add `?refresh=1` to skip the cache) returns the GitHub issues for the current sprint, read-only: `{ configured, available, repo, at, issues: [{ number, title, url, state, closedAt, updatedAt, labels, assignees }], error? }`. It is off (`{ configured: false, issues: [] }`) until `flowrail/config.json` has `"github": { "repo": "owner/name", "assignee": "@me" }` (`"*"` lists every issue someone is assigned to); the settings API cannot set that field. The server runs `gh issue list` (no shell, a 15 s timeout, JSON out), keeps the answer for five minutes in `.flowrail/github-issues.json`, and returns every open issue plus those closed between the sprint's start and end. When `gh` is missing, signed out or offline it returns `available: false` with `error: "GitHub unavailable"` and caches nothing. Nothing is ever written to GitHub.

### Docs

| Method | Path | Does |
|---|---|---|
| GET | `/api/docs/tree` | Nested tree of readable files: `[{ name, path, type, children? }]`. Gated files (see [security.md](security.md#the-path-gate)) are left out. |
| GET | `/api/docs/file?path=` | `{ path, text, mtime, kind, size, writable }` |
| POST | `/api/docs/file` | `{ path, text, mtime }` writes a `.md` or `.txt` file. `mtime` must match the file on disk, or the write is refused with `409`, "changed on disk", and the current `mtime`. |
| POST | `/api/docs/file` | `{ _action: "create", path, text? }` creates a file. |
| POST | `/api/docs/file` | `{ _action: "trash", path }` |

### Comments

`GET /api/comments?path=` returns the comments on one file, or all open comments when `path` is omitted. A comment is `{ id, path, quote, anchor?, body, author, createdBy, created, status, resolvedAt?, resolvedBy?, resolveNote?, sig?, verified }`, with `status` either `open` or `resolved`. `add` signs the comment (`sig`, HMAC-SHA256 with this machine's key, kept outside the repo). `verified` is computed on every read: `true` only when the signature checks out on this machine. A comment written into `.flowrail/comments/` by hand, or edited after it was added, is `verified: false`, and the session-start briefing lists it as unverified instead of as an instruction.

`POST /api/comments`:

| `_action` | Body |
|---|---|
| `add` | `path`, `quote`, `body`, optionally `anchor` and `author` |
| `resolve` | `path`, `id`, optionally `note` and `by` |
| `reopen` | `path`, `id` |
| `delete` | `path`, `id` |

### Memory

| Method | Path | Does |
|---|---|---|
| GET | `/api/memory` | `{ items: [{ name, type, description, created, body, links, path, seed? }], types }`. `seed: true` marks the starter memory `init` wrote. |
| GET | `/api/recall?q=&limit=` | `{ hits: [{ source, name, path, heading?, title, score, snippet }] }`. `source` is `memory` or `doc`; `limit` defaults to 8. |
| POST | `/api/memory` | `{ _action: "store", name, type, description, body, force? }` |
| POST | `/api/memory` | `{ _action: "trash", name }` |

### Red lines

`GET /api/redlines`

```json
{
  "lines": [{ "id": "no-push-without-asking", "title": "...", "why": "...", "severity": "ask", "hook": { "tool": "Bash", "builtin": "git-push" }, "summary": "Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync)", "builtin": "git-push", "links": { "rule": true, "check": false, "hook": true }, "state": "armed" }],
  "errors": [],
  "stats": { "held7d": 4, "byId": { "no-push-without-asking": 3 }, "probes7d": 1 },
  "events": [{ "at": "...", "id": "no-secrets-in-repo", "severity": "block", "decision": "deny", "tool": "Write", "subject": "config/.env", "path": "config/.env", "what": "writing .env" }],
  "changes": [{ "at": "...", "decision": "changed", "by": "dashboard", "added": [], "removed": ["no-push-without-asking"], "changed": [] }],
  "hooksInstalled": true,
  "hooksState": { "installed": true, "healthy": true, "where": "settings.json", "command": "node -e '/*flowrail-guard*/…' pre-tool-use || { …; exit 2; }" },
  "hooks": { "PreToolUse": true, "SessionStart": true, "SubagentStart": true, "SubagentStop": true },
  "checkResults": [{ "id": "...", "severity": "warn", "file": "docs/roadmap.md", "line": 30, "text": "...", "message": "..." }],
  "checkRanAt": "...",
  "headless": { "permissionMode": "dontAsk", "allowed": [], "disallowed": [] }
}
```

Each line carries four derived fields. `summary` is a plain-English sentence: what the builtin holds, or the line's `why` (its `title` when there is no `why`). `builtin` is the builtin's id or `null`. `links` says which parts of the chain exist. `state` is `armed` (a hook, and the hooks are healthy), `not-enforced` (a hook, but the hooks are missing or broken), `checked` (a check and no hook: enforced by `flowrail check` in CI, not at runtime) or `declared` (neither).

`errors` lists validation problems in `red-lines.json`. `events` holds the last 50 holds, newest first, without probes (hook calls with no Claude Code session) and without red-line changes; `subject` is redacted and relative to the project, and file tools also carry `path`. `stats.held7d` counts `block` and `ask` holds from the last seven days, probes excluded; `stats.probes7d` counts the probes. `changes` holds the last five saves made through this API. `hooksInstalled` is `true` only when the hooks are healthy; `hooksState` is the same object as `hooks` in `/api/overview`; `hooks` maps each event to whether it is present. `checkResults` is the cached result of the last check run.

`POST /api/redlines`:

| `_action` | Body | Does |
|---|---|---|
| `save` | `lines` | Replaces `red-lines.json`. The derived `summary`, `builtin`, `links` and `state` fields are dropped before writing. Refused with `400` and `errors` if the lines do not validate, for example when a regex does not compile or a builtin is unknown. Every save appends a `changed` entry to `.flowrail/redlines.log` and returns it as `change: { at, decision, by, added, removed, changed }`; the dashboard then shows it in Needs attention and Today. |
| `test` | `tool`, `subject` | `{ decision, line, what, normalized, reason }`: the decision the hook would make (`deny`, `ask`, `warn` or `allow`). A dry run: nothing is logged. |
| `check` | | Runs the file checks and returns `{ results, ranAt, files }`. |

### Knowledge graph

`GET /api/graph` returns `{ nodes: [{ id, kind, label, path?, size, ring, area?, href? }], links: [{ source, target, kind }], areas: [{ name, router }], truncated }`. `kind` is one of `doc`, `folder`, `memory`, `skill` (a skill or a `.claude/commands` command), `agent`, `workflow`, `routine`, `redline`, `artifact`, `hub`. `ring` is where the Rings view draws the node: `hub`, `skill`, `band` (documents), `routine` or `artifact`. `area` is the index into `areas` of the area a file or folder belongs to.

Areas come from `areas: [{ "name": "Sales", "router": "SALES.md" }]` in `flowrail/config.json`, or else from the rows of a table in `CLAUDE.md` that link a router (`| Sales | [SALES.md](SALES.md) | ... |`), at most 12. A file belongs to the area whose router names it (a Markdown link or a path in backticks) or names a folder above it; the most specific mention wins, and a router is in its own area. Links come from Markdown links, `[[wikilinks]]` and folder containment. At most 1500 nodes.

### Workflows

`GET /api/workflows` returns `[{ file, title, description, steps: [{ n, title, gate, body }], groups: [{ kind, title, steps }] }]` for every Markdown file with steps in `flowrail/workflows/`, or in the folder `workflowsDir` in `config.json` names (inside the repo). A `## Action: …` or `## Sub-command: …` heading opens a group (`kind` is `action` or `sub-command`) and the steps under it (`##` or `###`) belong to it. A step whose heading says GATE, SIGN-OFF or MANDATORY has `gate: true`.

### Routines

`GET /api/routines` returns each routine from `routines.json` with `enabled`, `scheduleText` (for example "Mondays 07:00"), `installed`, `lastRun: { at, exit, run, firstLine? } | null` and `next`.

An **event routine** has `on` instead of `schedule`: `{ "event": "github-actions", "repo": "owner/name", "workflow": "ci.yml" }` for a GitHub Actions workflow, or `{ "event": "hook" }` for one something else runs (its runs are the lines in `.flowrail/runs/routines.log` with its id). It is never scheduled (`installed` and `next` are `null`), and `run` refuses it with `409` unless it also has a `run`. A GitHub Actions routine also carries `github: { runs: [{ status, conclusion, at, title, branch, url }], at } | { error: "GitHub unavailable", at }`, read with `gh run list` (read-only, 8 s timeout) and cached for five minutes in `.flowrail/github-runs.json`. `url` is kept only when it is a `https://github.com/` link.

`POST /api/routines`:

| `_action` | Body |
|---|---|
| `run` | `id`. Starts a routine that is already in `routines.json` and returns without waiting for it. |
| `install` | Schedules the enabled routines. Refused with `403` while an enabled `command` routine exists: those are scheduled from the terminal with `flowrail-room routines install`, which shows each command first. |
| `uninstall` | |
| `save` | `routines`. Claude routines can be added and changed. A `command` routine can only be kept, rescheduled, disabled or removed: adding one, or changing what an existing one runs, is refused with `403`. Command routines are edited in `flowrail/routines.json`. |

### Agents (team)

`GET /api/team` returns `{ agents, skills, commands }`: the agents in `.claude/agents` (`name`, `description`, `model`, `tools`, `source`, `state`, `lastAt`), the skills (`name`, `description`, `path`) and the slash commands (`name`, `description`, `path`).

### Artifacts

| Method | Path | Does |
|---|---|---|
| GET | `/api/artifacts` | `[{ name, title, summary, created, tags, size, href }]`. `name` is the file name, such as `weekly-digest.html`. |
| POST | `/api/artifacts` | `{ _action: "trash", name }` |
| GET | `/artifacts/<name>` | The artifact itself (the `href` above), served in a sandbox (see [security.md](security.md#artifacts)). |

### Links

`GET /api/links` returns `flowrail/links.json` normalized: `[{ category, items: [{ title, url, href, external, description, icon? }] }]`. A category may call its list `items` or `links`. An `http`/`https` URL gets `external: true` and its own `href`; a repo path gets `href: "#/docs?path=…"`; any other URL (`javascript:`, `data:`, `file:`, `..`) is dropped, and so is a category left empty. `icon` is kept only when it is an icon name, never markup.

### Library

`GET /api/library` returns `{ docs: [{ path, title, area, changed, days, state, uncommitted? }], counts: { fresh, aging, stale, unknown }, thresholds: [aging, stale], source, areas: [{ name, router, docs }] }`. Every servable Markdown file in the repo (the same gates as Docs). `changed` comes from one `git log` over the history (`source: "git"`); a file changed since its last commit, or untracked, takes its file time and `uncommitted: true`; outside git every file takes its file time (`source: "mtime"`). `state` is `fresh` below `staleDays[0]` days (default 30), `aging` below `staleDays[1]` (default 90), `stale` after. `area` is the area whose router names the file or a folder above it (see [concepts.md](concepts.md#library-areas-and-context)), or `null`.

### Context

`GET /api/context` returns `{ dir, entries: [{ slug, title, source, summary, path, docs, changed }], error? }`: one entry per folder of `contextDir` (default `flowrail/context`) that holds an `index.md`, with that file's frontmatter `title`, `source` and `summary`, and the other Markdown files next to it in `docs`.

### Runs

| Method | Path | Does |
|---|---|---|
| GET | `/api/runs` | Recent runs: `[{ id, kind, routine?, title, startedAt, endedAt, exit, status }]`. |
| GET | `/api/runs/<id>` | One run, with its output in `log`. |
| POST | `/api/run` | `{ prompt }` starts a headless Claude run, if `claude` is installed, and returns the run record. One at a time. The dashboard does not call this; it is there for scripts. |
| GET | `/api/automation` | The Runs page in one call: `{ runs, headless: { permissionMode, allowed, disallowed }, apps, appsError }`. |

### Apps

Local programs listed in `flowrail/config.json` as `"apps": [{ "id", "name", "cmd": [argv], "cwd"?, "url"? }]` (`cwd` is a folder inside the repo, `url` is http or https). The list is file-only: `POST /api/config` ignores `apps`, and no endpoint adds one or changes what it runs.

| Method | Path | Does |
|---|---|---|
| GET | `/api/automation` | `apps: [{ id, name, cmd, cwd, url, running, pid, reachable }]`. `reachable` is probed only for a loopback `url` of a running app, else `null`. An invalid `apps` list comes back as `appsError`. |
| POST | `/api/apps` | `{ _action: "start" \| "stop", id }`. Start runs `cmd` detached, without a shell, in its own process group, output to `.flowrail/apps/<id>.log` (`409` if it is already running, `404` for an id that is not in `config.json`). Stop sends `SIGTERM` to the process group. |
| GET | `/api/apps/log?id=<id>` | `{ id, log }`: the last 20 KB of the app's output. |

### Search, events, doctor

| Method | Path | Does |
|---|---|---|
| GET | `/api/search?q=` | `[{ kind, title, href }]` across doc names and headings, tasks and memory. Feeds the command palette. |
| GET | `/api/events?token=` | Server-sent events. Sends `hello` on connect, then `change` with `{ area }`, where `area` is `board`, `comments`, `memory`, `redlines`, `routines`, `artifacts`, `agents` or `docs`. The token goes in the query string. |
| GET | `/api/doctor` | `{ checks, headless, threatModel, server: { host, port } }`. `checks` are the same checks as `flowrail doctor`: `[{ id, title, status, detail, fix? }]` with `status` `ok`, `warn` or `fail`. |
