# Getting started

This walks you through the first fifteen minutes with flowrail in a project you already work on. By the end, Claude will have tried to push and been held by a rule, acted on a comment you left in a document, filed a task and stored a memory.

You need Node 20 or later, a git repository, and [Claude Code](https://docs.claude.com/en/docs/claude-code). If you want to look around before touching your own project, run `npx @finalangel/flowrail-os demo` instead: it builds an example workspace in a temp folder.

## Minute 0: install

In the root of your project:

```sh
npx @finalangel/flowrail-os init
```

This walkthrough uses the optional flowrailOS (`@finalangel/flowrail-os`): the guard plus a board, docs and memory. If all you want is the guard (red lines and hooks, no board, memory or `CLAUDE.md` block), run `npx flowrail init` instead, then read minutes 1, 2 and 11.

flowrail looks before it writes. It prints what it found, for example:

```text
Found  git repo, CLAUDE.md with 3 rules
```

Then it lists every file it will add or change: the guard in `.claude/flowrail/guard/`, the new `flowrail/` folder, a `.flowrail/` line in `.gitignore`, a two-line marked block in `CLAUDE.md` (the guard-only `flowrail init` writes none), and four hook entries in `.claude/settings.json` (PreToolUse, SessionStart, SubagentStart, SubagentStop). It shows the diff for each file that already exists and asks before going on. Your existing hooks and settings are kept.

The guard is a copy of a few plain Node files and a manifest of their hashes, committed with the repo. The hooks check it against that manifest and run it with plain `node` (a guard that was deleted or edited blocks every call), so it works for everyone who clones the repo, before any `npm install`, and nothing is added to `package.json`. A call through the guard takes about 50 ms on a laptop, most of it Node starting up ([hooks.md](hooks.md#pre-tool-use)).

## Minute 1: your own rules, and the starters

`init` reads `CLAUDE.md` and `AGENTS.md` for rules you have already written and lists every one with a verdict:

```text
Rules in your own files (3)
  covered      "Never push without asking"  CLAUDE.md
               no-push-without-asking: Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync, and git aliases that push)
  partial      "Do not edit .env"  CLAUDE.md
               no-secrets-in-repo: Blocks writing .env files, keys and other secret files, ... Not held: a secret pasted into an ordinary file is only found by the private-key check (flowrail check)
  not covered  "Always update CHANGELOG.md when you change the public API"  CLAUDE.md
               rule-always-update-changelog-md-when-you: no recipe holds this; kept as a declared-only red line so it shows up on the dashboard
```

`covered` means a red line with a hook holds it. `partial` says what is held and what is not. A `not covered` rule is written into `flowrail/red-lines.json` as "declared only", so it stays visible on the dashboard until you add a hook for it. Where a recipe fits a rule, `init` asks:

```text
You wrote "Do not deploy without approval". Enforce it as no-deploy-without-asking (ask)? [Y/n]
```

Whatever you answer, you get six starter red lines: ask before any `git push`, block destructive git commands, block writing secret files and ask before reading them, block recursive deletes outside the project, ask before MCP tools send, post, push, merge, delete or pay, and `protect-flowrail`, which asks before anyone edits the red lines, the guard, flowrail or Claude settings, uninstalls the hooks, or calls the dashboard's local API. `protect-flowrail` is built into the guard, so deleting it from the file does not switch it off. If the repo shows tools such as `terraform` (a `*.tf` file), `kubectl` or a deploy step in CI, `init` also offers the matching starters (`publish-deploy`, `infra-destructive`); what is on your PATH does not count. They are in `flowrail/red-lines.json`; open it and read them. `init` ends by probing every red line with calls it must hold and calls it must allow; `npx flowrail redlines verify` runs the same check later.

Check the setup:

```sh
npx flowrail doctor
```

Every line should pass. If something does not, doctor says how to fix it. `npx flowrail redlines` lists each rule with a plain-English summary and its state: **armed** (hook installed, held at runtime), **checked in CI** (a file check only, run by `flowrail check`), **declared only** (written down, nothing enforces it yet) or **not enforced** (it has a hook, but the hooks are missing or point at a program that is gone).

## Minute 2: watch a red line hold

Start Claude Code as you normally do:

```sh
claude
```

Ask it to push:

```text
> push the current branch to origin
```

Claude runs `git push origin main`, or some variant of it. Before the command executes, the flowrail hook matches it against `no-push-without-asking` and tells Claude Code to ask. You see a permission prompt carrying the reason:

```text
flowrail red line no-push-without-asking: Never push without asking (git push). Pushing publishes work. A human decides when.
```

Decline it. Then try a sneakier version, `git -C . push` or `bash -lc 'git pu\sh'`. The hook parses the command before matching, so these are held too. You can test commands without running them:

```sh
npx flowrail redlines test "sudo git -c core.x=y push --tags"
```

## Minute 4: open the dashboard

In a second terminal:

```sh
npx @finalangel/flowrail-os
```

Your browser opens `http://127.0.0.1:4747`. The dashboard shows what needs you, a setup checklist driven by the files on disk, the red lines strip ("6 armed · held 1× this week"), the Today card and the sprint with four onboarding tasks. The header says "Guard live" when the hooks are installed and the guard's files match what flowrail shipped.

The Today card lists what happened in the repo since midnight: the push you just declined, tasks filed and moved, commits, memories. The onboarding tasks and the starter memory and report are not news, so they never show there. When you come back after a while, "While you were away" lists what happened since your last visit. `npx @finalangel/flowrail-os today` prints the day's list.

Open Red lines. Each rule leads with a summary of what it holds, and the push you declined is in the log.

## Minute 6: leave a comment for Claude

Go to Docs and open `flowrail/WELCOME.md`, or any Markdown file in your project. Select a sentence and click **Comment**. Write an instruction, for example "Rewrite this as a numbered list".

Start a new Claude Code session (or type `/clear`). The session-start hook tells Claude there is an open comment and treats it as an instruction. Ask it to deal with it, or just say "go". Claude edits the file and resolves the comment with a note. The dashboard updates by itself: the comment turns to "Resolved" and shows the note.

## Minute 9: tasks and memory

Ask Claude to file something:

```text
> file a task to update the changelog before the next release
```

Claude runs flowrailOS's `task` command (`npx @finalangel/flowrail-os task "Update the changelog before the next release"`). It lands in the current sprint (add `--sprint backlog` to park it), shows up in `tasks`, and appears on the board tagged "Filed by agent". A task you file yourself from a terminal is yours: it is assigned to your `git config user.name` (or "you").

Ask it to remember something:

```text
> remember that releases are cut from the release branch, never from main
```

Claude runs `npx @finalangel/flowrail-os remember "..." --name release-branch` (the type defaults to `project`) and writes `flowrail/memory/release-branch.md`. In a later session, `npx @finalangel/flowrail-os recall "which branch do releases come from"` finds it, and so does the Memory page. Recall is plain word matching with light stemming and a few synonyms (deploy, release and ship; npm, pnpm, yarn and "package manager"; schedule and weekdays), so "release schedule" finds "we deploy on Fridays".

## Minute 11: what would it have caught?

```sh
npx flowrail audit
```

```text
Last 30 days: 1,431 tool calls in 28 sessions.
flowrail would have held 4 (3 no-destructive-git, 1 no-rm-rf-outside-project) and asked first on 6 (3 no-push-without-asking, 2 no-secrets-in-repo, 1 ask-before-mcp-actions).
```

`audit` replays the tool calls in your recent Claude Code sessions for this project through the red lines you have now and lists every one that would have been held or asked about. It reads the transcripts Claude Code keeps on this machine (`~/.claude/projects`, or under `CLAUDE_CONFIG_DIR`), writes nothing and calls no model. `--days 7` narrows the window; `--json` gives the full list. With no transcripts yet, `npx flowrail audit --demo` runs the same report over a bundled sample project.

## Minute 12: add a rule of your own

Think of one thing you never want an agent to do in this project. Add it to `flowrail/red-lines.json`, use **Add red line** in the dashboard, or pick a recipe: `npx flowrail redlines add --list` shows them all and `npx flowrail redlines add no-deploy-without-asking` adds one. [red-lines.md](red-lines.md#recipes) explains each. Test it with `flowrail redlines test`, and commit `flowrail/` so the rule travels with the repo.

Editing `red-lines.json` yourself is fine. When an agent tries it, `protect-flowrail` asks you first. After a change made outside flowrail, every tool call asks until you review it: run `npx flowrail redlines accept` in your own terminal.

## Where next

- [concepts.md](concepts.md) explains each part.
- [red-lines.md](red-lines.md) is the full reference for rules, including what they cannot hold.
- [cli.md](cli.md) lists every command.
- To remove flowrail: `npx flowrail uninstall` removes the guard, its hooks and the `CLAUDE.md` block and leaves your `flowrail/` files alone.
