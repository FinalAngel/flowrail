---
name: sync-merges-per-paragraph
type: project
description: Sync merges edits per paragraph, not per note, so two devices rarely conflict
created: {{DAYS_AGO_40}}
---
**Why:** most people edit different parts of a note on phone and laptop. Whole-note last-write-wins lost work in the 0.7 beta.

**How to apply:** any change to `src/sync.js` keeps paragraph granularity. See docs/architecture.md and [[flaky-tests-go-to-quarantine]] for the sync tests.
