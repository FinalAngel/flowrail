---
name: flowrail-basics
type: reference
description: Where flowrail keeps its state and which commands agents use
created: {{DATE}}
seed: true
---
flowrail state lives in `flowrail/` (committed) and `.flowrail/` (per machine, gitignored).

Agents use the CLI rather than editing the JSON by hand: `{{CLI}} task`, `{{CLI}} comments`, `{{CLI}} resolve`, `{{CLI}} remember`, `{{CLI}} recall`.

**Why:** the CLI validates input and keeps IDs and the memory index consistent.

**How to apply:** when a task, comment or fact needs to change, reach for the command first. See [[flowrail-basics]] in the dashboard's Memory page.
