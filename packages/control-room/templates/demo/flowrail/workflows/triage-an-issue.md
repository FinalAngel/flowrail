# Triage an issue

Turn a new bug report into a task someone can pick up.

## Step 1: Reproduce

Follow the steps in the report on a clean checkout. If it does not reproduce, ask one precise question and stop.

## Step 2: Find the smallest failing case

Write it as a test in `test/`. A failing test is worth more than a long description.

## Step 3: GATE: agree on priority

Propose P0 to P3 with one sentence of reasoning. The human confirms before anything is scheduled.

## Step 4: File it

`npx @flowrail/control-room task "<title>" --priority P2 --label bug --sprint backlog` and link the failing test in a note.
