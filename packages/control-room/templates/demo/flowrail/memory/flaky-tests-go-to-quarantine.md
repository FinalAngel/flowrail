---
name: flaky-tests-go-to-quarantine
type: feedback
description: A flaky test moves to test/quarantine with a task, it is never retried until green
created: {{DAYS_AGO_21}}
---
Quarantined tests still run nightly, so a fix shows up as green there first.

**Why:** retries hid a real race in the merge code for two weeks.

**How to apply:** when a test fails once and passes on rerun, quarantine it and file `npx @finalangel/flowrail-room task "Flaky: <name>" --label flaky`.
