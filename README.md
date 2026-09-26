<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img alt="flowrail" src="assets/logo.svg" width="264" height="80">
  </picture>
</p>

<p align="center"><strong>Guardrails for Claude Code that hold.</strong><br>A <code>PreToolUse</code> hook parses every command before it runs, and the agent cannot quietly switch it off.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/flowrail"><img alt="npm" src="https://img.shields.io/npm/v/flowrail?color=0E7C66"></a>
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/license-MIT-0E7C66"></a>
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-0E7C66">
  <img alt="Node 20 or later" src="https://img.shields.io/badge/node-%3E%3D20-0E7C66">
  <img alt="No telemetry" src="https://img.shields.io/badge/telemetry-none-0E7C66">
  <a href="https://github.com/FinalAngel/flowrail/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/FinalAngel/flowrail/actions/workflows/ci.yml/badge.svg"></a>
</p>

<p align="center"><img alt="A terminal: npx flowrail init finds two rules in CLAUDE.md, marks both covered and verifies 7 red lines. In a Claude Code session, git push --force origin main and rm -rf ~ are each held with the red line's reason. npx flowrail audit --demo replays fictional sessions and lists what flowrail would have held or asked beyond what settings.json already catches." src="assets/demo.svg" width="920"></p>

```sh
npx flowrail redlines test "git push --force origin main"   # try it; no install, no workspace needed
npx flowrail init                                           # add the guard to this repo; shows every change, then asks
npx flowrail audit                                          # what it would have caught in your past sessions (--demo: fictional ones)
```

The same guard for a small business, with Gmail, Stripe and Google Calendar connected as MCP servers and the `no-payments` recipe added:

| Tool call | flowrail |
|---|---|
| `mcp__claude_ai_Gmail__create_draft` | allowed |
| `mcp__claude_ai_Gmail__send_message` | ask |
| `mcp__claude_ai_Google_Calendar__create_event` | ask (invites go out) |
| `mcp__stripe__create_refund` | block |

*block* = the call never runs; *ask* = Claude Code asks you first; *held* = either of the two.

Out of the box it blocks destructive git (force pushes, hard resets, forced cleans and branch deletes), `rm -rf` outside the project and writing secrets, and it asks before any other push, before reading secrets and before an MCP tool sends, merges, deletes or pays. Drafts are fine. `init` offers more red lines for what your repo uses: mail and payment servers, deploys, infrastructure, databases and paths you name in `CLAUDE.md`.

The guard also guards itself. Commands that would edit or empty its files, the rules or the settings ask first, a guard file changed anyway blocks every call, and rules changed outside flowrail make every call ask until you review them in your own terminal. The [tamper model](docs/tamper-model.md) lists every way we know to switch it off, with its status.

The bypass corpus runs in CI: **848 bypass probes held, 330 false-positive probes allowed, 22 known gaps documented**. `node packages/flowrail/scripts/corpus-stats.js` prints the scoreboard per matcher. A call through the guard takes about 50 ms, about 30 ms of it Node starting ([measurements](docs/hooks.md#pre-tool-use)).

## Why not a grep hook

Most people start with a hand-rolled hook that greps the command. A typical one:

```bash
#!/usr/bin/env bash
# .claude/hooks/guard.sh: a PreToolUse hook. Exit 2 blocks the call.
input=$(cat)
tool=$(jq -r '.tool_name' <<<"$input")
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")

block() { echo "Blocked: $1" >&2; exit 2; }

if [ "$tool" = "Bash" ]; then
  echo "$cmd" | grep -q 'git push' && block "no git push without asking"
  echo "$cmd" | grep -q 'git reset --hard' && block "no hard reset"
  echo "$cmd" | grep -q 'git clean -fd' && block "no forced clean"
  echo "$cmd" | grep -q 'git branch -D' && block "no forced branch delete"
  echo "$cmd" | grep -qE 'rm -rf (/|~)' && block "no rm -rf on / or ~"
  echo "$cmd" | grep -qE '> *\.env' && block "no writing .env"
fi
if [ "$tool" = "Write" ] || [ "$tool" = "Edit" ]; then
  [[ "$file" == *.env ]] && block "no writing .env"
fi
exit 0
```

Each row below was piped through both hooks as a `PreToolUse` event:

| Tool call | Grep hook | flowrail |
|---|---|---|
| `git -C . push` | allowed | ask |
| `git pu\sh` | allowed | ask |
| `git send-pack origin main` | allowed | ask |
| `git clean --force -d` | allowed | block |
| `git branch --delete --force feature` | allowed | block |
| `git checkout -- .` | allowed | block |
| `rm -rf ${HOME}` | allowed | block |
| Write `config/.ENV` | allowed | block |
| `cat .env` | allowed | ask |
| `mcp__github__merge_pull_request` | allowed | ask |
| `git config core.fsmonitor "sh -c evil"` | allowed | ask |
| `sed -i "" "s/node/true/" .claude/settings.json` | allowed | ask |
| `echo "[]" > flowrail/red-lines.json` | allowed | ask |
| `grep -r "git push" docs` | blocked | allowed |
| `git push --dry-run origin main` | blocked | allowed |
| `rm -rf /tmp/build/*` | blocked | allowed |

The last three rows are false positives, and a hook that blocks a search for the words "git push" soon gets switched off. The three rows above them are the agent disarming a hook: running code through git config, editing the settings, emptying the rules. flowrail splits each command into argv first, undoing quotes, escapes, wrappers (`sudo`, `env`, `sh -c`, `eval`, `xargs`) and git's global options, and then reads subcommands and flags the way the program does.

A red line reads the command it is given. It does not see inside `./release.sh`, a variable that holds a command, or base64 piped to a shell. [docs/red-lines.md](docs/red-lines.md#what-a-red-line-does-not-hold) lists every known gap, and each one is a `GAP` line in [the corpus](packages/flowrail/test/corpus/).

## Tamper model

flowrail assumes that at some point the agent will try to get a forbidden thing done by changing the guard instead of asking. The hook command in `settings.json` checks every guard file against its manifest, and the manifest against a hash pinned in the command, before it runs anything, so a guard that is deleted, emptied or edited, or a missing `node`, blocks the call. `protect-flowrail` is compiled in and stays on when `red-lines.json` is emptied. Every decision goes to a hash-chained journal outside the repo.

What is left: a script on disk that does the forbidden thing inside it, encoded commands piped to a shell, MCP tools whose names say nothing about what they do, and programs you run yourself. Where one mistake is expensive, add a control the agent cannot touch, such as branch protection or credentials it does not have. [docs/tamper-model.md](docs/tamper-model.md) lists every path as held, asked, detected or gap, and each held row is a test.

## Coverage you can check

`init` reads your `CLAUDE.md` and `AGENTS.md`, says which rules a red line covers and which are only declared, offers a recipe where one fits, and then probes every red line it armed. From a fresh repo whose `CLAUDE.md` says "Never push to main without asking" and "Do not delete anything in content/":

```text
Rules in your own files (2)
  covered      "Never push to main without asking"  CLAUDE.md
               no-push-without-asking: Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync, and git aliases that push)
  covered      "Do not delete anything in content/"  CLAUDE.md
               protect-path-content: Blocks deleting, moving or overwriting files under content/** (rm, mv, git rm, find -delete, > redirects, Write over an existing file); editing part of a file is fine
```

`npx flowrail redlines verify` runs the same probes at any time and exits non-zero if a probe that should be held is not:

```text
  ✓ no-push-without-asking    held 3/3   allowed 3/3
  ✓ no-destructive-git        held 4/4   allowed 3/3
  ✓ no-secrets-in-repo        held 5/5   allowed 3/3
  ✓ no-rm-rf-outside-project  held 4/4   allowed 2/2
  ✓ protect-flowrail            held 5/5   allowed 3/3
  ✓ ask-before-mcp-actions    held 2/2   allowed 2/2
  ✓ protect-path-content      held 6/6   allowed 3/3
✓ Verified: 7 rules, 29 probes held, 19 allowed as expected.
held = dangerous examples stopped; allowed = harmless examples let through; block = never runs; ask = Claude Code asks you first
```

`npx flowrail audit` replays the tool calls in your recent Claude Code transcripts for this project through the red lines you have now, and subtracts what the `deny` and `ask` rules in your `settings.json` would have caught anyway, so the list is what flowrail adds. It reads local files, writes nothing and calls no model. To see the format first, `npx flowrail audit --demo` replays the fictional transcripts bundled with the package. Its output, as a demo transcript (run with `TZ=UTC`):

```text
Demo: fictional transcripts bundled with flowrail (a made-up project, /work/acme-shop, whose settings.json denies git push --force and asks before git push), replayed through the starter red lines.

Last 30 days: 20 tool calls in 3 sessions.
flowrail would have held 3 (2 no-destructive-git, 1 no-rm-rf-outside-project) and asked first on 5 (2 no-push-without-asking, 1 ask-before-mcp-actions, 1 no-secrets-in-repo, 1 protect-flowrail).
Your settings.json permissions (2 deny/ask rules) would have caught 2; flowrail adds 6:

  held   Jun 8, 10:10    no-destructive-git        git reset --hard origin/main
  asked  Jun 8, 10:06    no-push-without-asking    mcp__github__merge_pull_request {"pullNumber":42}
  asked  Jun 8, 10:04    ask-before-mcp-actions    mcp__gmail__send_email {"to":"customer@example.com","subject":"Your refund","body":"Done."}
  held   Jun 4, 14:22    no-rm-rf-outside-project  rm -rf ../acme-shop-old
  asked  Jun 4, 14:20    protect-flowrail            Write .claude/settings.json
  asked  Jun 2, 09:25    no-secrets-in-repo        cat .env
held = blocked, it never runs; asked = Claude Code asks you first.

Run it on your own sessions: npx flowrail audit (read-only, local, no model).
```

More red lines come from plain-English recipes (`protect-path`, `publish-deploy`, `infra-destructive`, `db-destructive`, `no-payments` and others): `npx flowrail redlines add --list` shows them, and [docs/red-lines.md](docs/red-lines.md#recipes) explains each.

## Control Room (optional)

A separate package, [`@finalangel/flowrail-room`](packages/control-room/), adds a local dashboard on top of the guard. The guard does not need it.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.png">
    <img alt="The Control Room's Red lines page: the Try it box showing git push --force origin main held by no-destructive-git, and the audit panel listing what these rules would have held or asked about." src="assets/hero.png" width="1280">
  </picture>
</p>

```sh
npx @finalangel/flowrail-room demo   # look around a sample workspace in a temp folder
npx @finalangel/flowrail-room init   # the guard plus the control room files
npx @finalangel/flowrail-room        # the dashboard on http://127.0.0.1:4747
```

It shows each red line in plain English with its held count, a Try it box and the audit; comments on Markdown files that the next Claude Code session picks up; a board, a memory store with keyword recall, and what happened in the repo today.

It listens on `127.0.0.1` only and keeps everything in `flowrail/` (committed) and `.flowrail/` (per machine). More in [docs/getting-started.md](docs/getting-started.md).

## FAQ

**Does it send my data anywhere?** No. The guard and `audit` read local files. The dashboard makes no outbound connections: no telemetry, no account, no update check.

**What does `init` change?** It copies the guard (plain Node files and a manifest of their hashes) into `.claude/flowrail/guard/`, writes `flowrail/red-lines.json` and `flowrail/config.json`, and adds hook entries to `.claude/settings.json`, keeping any hooks you already have. It writes no `CLAUDE.md` block. Commit those files and everyone who clones the repo is guarded, with no `npm install`.

**How does it compare to Claude Code permission rules?** Permission rules (`allow`, `ask`, `deny` in `settings.json`) match a tool and a command pattern, and they are the right place for plain lists. flowrail parses the command and its flags, protects its own files and logs every decision. `init` reads your `permissions.deny` and `ask` and reports the rules they already cover. Use both.

**What if the guard breaks?** It fails closed, as above. `npx flowrail doctor` checks the setup and prints a fix; `npx flowrail upgrade` restores the guard files from the package; `npx flowrail uninstall` removes the guard and its hooks and leaves `flowrail/`.

**Why the name?** The mark is a path running between two rails: your agent keeps its flow, and the red lines are the rails it stays between.

More in [docs/faq.md](docs/faq.md). To have an agent do the setup, point it at [INSTALL.md](INSTALL.md).

## Documentation

- [Getting started](docs/getting-started.md), [concepts](docs/concepts.md) and the [CLI](docs/cli.md)
- [Red lines](docs/red-lines.md): schema, built-in matchers, the shell parser, known gaps, recipes, CI
- [Tamper model](docs/tamper-model.md), [hooks](docs/hooks.md) and the [security model](docs/security.md)
- [HTTP API](docs/api.md) and [extending](docs/extending.md) (Control Room)
- [Roadmap](ROADMAP.md) and [changelog](CHANGELOG.md)

## Contributing

The most useful pull request is a probe: a command that gets past a built-in matcher, added as a failing `HOLD` line in [the corpus](packages/flowrail/test/corpus/). [CONTRIBUTING.md](CONTRIBUTING.md) has the ground rules (zero dependencies, no build step, nothing leaves the machine). Questions go in [Discussions](https://github.com/FinalAngel/flowrail/discussions).

## License

[MIT](LICENSE)
