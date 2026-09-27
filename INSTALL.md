# Installing flowrail

This file is written for a coding agent. A person can point their agent at it ("Read INSTALL.md from the flowrail repo and install it here") and the agent follows the steps below. People reading it for themselves will find the same steps in [docs/getting-started.md](docs/getting-started.md).

---

You are installing flowrail in the user's current project. flowrail is first a guard: Claude Code hooks that enforce the user's rules ("red lines") before a tool runs, from a small copy of the guard committed into the repo. Optionally it adds flowrailOS, a local dashboard: board, docs you comment on, memory and a daily log, as plain files in `flowrail/`.

Follow these steps in order. Do not skip the questions: the user decides what changes in their repo.

## 1. Detect

Run these and note the results. Do not change anything yet.

```sh
node --version                 # needs 20 or later
git rev-parse --show-toplevel  # the project root; run the rest from there
ls flowrail/config.json          # already installed?
ls CLAUDE.md AGENTS.md .claude/settings.json .claude/agents 2>/dev/null
command -v claude gh
```

- If Node is older than 20, stop and tell the user. flowrail will not run.
- If `flowrail/config.json` exists, flowrail is already set up. Skip to step 4 and offer `npx flowrail upgrade` instead of `init`.
- If this is not a git repository, flowrail still works, but say so: the user loses the ability to review flowrail changes with `git diff`.
- `claude` and `gh` are optional. Without Claude Code the dashboard, board, memory and checks work, but hooks do nothing.
- Ask whether the user wants **the guard only** (`npx flowrail init`: red lines and hooks, nothing else) or **the guard plus flowrailOS** (`npx @finalangel/flowrail-os init`, a separate optional package).

## 2. Explain

Tell the user, in a few sentences, what will happen:

- The guard is copied into `.claude/flowrail/guard/`: a few plain Node files and a `manifest.json` of their hashes. It is meant to be committed. The hooks call it with `node`, so it works for everyone who clones the repo, before any `npm install`. **Nothing is installed with npm and `package.json` is not touched.**
- Four hook entries (PreToolUse, SessionStart, SubagentStart, SubagentStop) are merged into `.claude/settings.json`. Existing hooks and settings are kept.
- `flowrail/red-lines.json` gets six starter red lines, plus `publish-deploy` or `infra-destructive` when `init` finds tools such as `gh`, `kubectl` or `terraform` on the PATH (it asks first): ask before any `git push`; block destructive git commands; block writing secret files and API keys (and ask before reading secret files); block recursive deletes outside the project; `protect-flowrail`, which asks before anyone edits the red lines, the guard, the hooks, `.git/config`, `.git/hooks` or `.mcp.json`, and is built into the guard so it cannot be removed; and ask before MCP tools send, post, push, merge, delete or pay.
- `init` lists the MCP servers it finds and asks whether to guard their send/push/merge tools.
- `init` reads `CLAUDE.md` and `AGENTS.md` and lists every rule it finds as covered, partial or not covered, and says which list items it skipped because they are not rules. Rules nothing covers are written into `red-lines.json` as "declared only", so they stay visible.
- `.flowrail/` is added to `.gitignore`. It holds per-machine state.
- The guard-only `npx flowrail init` writes no `CLAUDE.md` block: the hooks need no instructions. With `npx @finalangel/flowrail-os init` there is also a `flowrail/` board, docs and memory with starter content, and a two-line block between `<!-- flowrail:start -->` and `<!-- flowrail:end -->` in `CLAUDE.md` that tells future sessions to stop and ask when a red line holds, and where reports go.
- Nothing is sent over the network. No account is created.

## 3. Ask, then install

Ask the user whether to proceed, and whether they want the guard only or the full install. Wait for the answer.

Then run it interactively, so the user sees each diff and answers each prompt themselves:

```sh
npx flowrail init                 # the guard only
npx @finalangel/flowrail-os init   # the guard plus flowrailOS
```

`init` lists the rules it found in the user's files with a verdict, the files it will touch, and diffs for files that already exist. It may ask whether to guard the MCP servers it found, and whether to enforce a rule it recognizes (`You wrote "Do not deploy without approval". Enforce it as no-deploy-without-asking (ask)? [Y/n]`). At the end it probes every red line with calls it must hold and calls it must allow, and shows what the red lines would have caught in the user's last 30 days of Claude Code sessions (read locally, nothing is sent). Relay these prompts to the user; do not answer them on the user's behalf.

Run without a terminal and without `--yes`, `init` prints "Non-interactive: showing the plan. Re-run with --yes to apply.", shows the plan and changes nothing. Use `--yes` only if the user explicitly asked you to accept everything.

## 4. Verify

```sh
npx flowrail doctor
```

Every check should pass (a missing `git`, `claude` or `gh` is only a warning). If one fails, doctor prints the fix. "Guard files" must say the files match their manifest and this flowrail; if not, `npx flowrail upgrade` restores them. Apply a fix only after telling the user what it changes, then run doctor again.

Hooks are loaded when a Claude Code session starts. If you are running inside Claude Code now, tell the user that the red lines take effect in the next session (start a new one, or `/clear`).

## 5. Demonstrate the red line

Show the user that a rule holds, without running anything risky:

```sh
npx flowrail redlines test "git push origin main"
npx flowrail redlines test "git -C . push"
npx flowrail redlines test "git status"
```

The first two should report `held (ask first)` from `no-push-without-asking`. The third should report `allowed  no red line matches`. Explain that the hook parses commands before matching, which is why the second form is held too.

Then suggest the live version for their next session: ask Claude to push the current branch, and watch Claude Code ask for permission with the red line's reason.

## 6. Hand over

Tell the user:

- `npx flowrail redlines` lists what is armed, and `npx flowrail audit` replays their past sessions through the red lines.
- If they chose flowrailOS, `npx @finalangel/flowrail-os` opens the dashboard at `http://127.0.0.1:4747`. The setup checklist on the first screen shows what is left.
- Commit `.claude/flowrail/guard/`, `.claude/settings.json` and `flowrail/red-lines.json`, so teammates get the guard when they clone.
- `flowrail/red-lines.json` is where their rules live. Recipes: [docs/red-lines.md](docs/red-lines.md#recipes).
- `npx flowrail uninstall` removes the guard, its hooks and the `CLAUDE.md` block and leaves their data.

Do not commit the new files unless the user asks you to.
