# Welcome to flowrail

This folder is the state of your project's flowrailOS. Everything in it is a plain file you can read, diff and commit. Delete `flowrail/` and nothing else in your repo changes.

## What is here

- `red-lines.json` holds your hard rules. Each one with a `hook` is checked by Claude Code before every tool call. Try it: start `claude` and ask it to push.
- `board.json` is the sprint board. Agents file tasks with `{{CLI}} task "..."`.
- `memory/` keeps one fact per file. `{{CLI}} recall "question"` finds them without calling a model.
- `workflows/` holds step-by-step procedures. A step named GATE or SIGN-OFF is where the agent stops and asks you.
- `routines.json` schedules report-only runs. Reports land in `artifacts/`.

## Comments are instructions

Select any sentence in this file on the dashboard and press Comment. The next Claude Code session in this folder sees your comment at start, acts on it and resolves it with a note. Try it on the line below.

> Replace this line with one sentence about what this project is for.

## Next

Run `{{CLI}}` for the dashboard, or `{{CLI}} status` for a one-screen summary.
