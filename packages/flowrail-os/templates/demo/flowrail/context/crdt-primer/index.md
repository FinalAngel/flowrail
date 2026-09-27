---
title: CRDT primer
source: Team reading group, week 3
summary: The smallest set of ideas behind conflict-free merges, with the trade-offs we accepted.
---

# CRDT primer

Notes from the reading group, in our own words.

1. Every change carries enough history to be merged in any order.
2. Deletes leave a tombstone, so a late edit to a deleted paragraph is not lost silently.
3. The cost is metadata: roughly 20 bytes per paragraph for us.
