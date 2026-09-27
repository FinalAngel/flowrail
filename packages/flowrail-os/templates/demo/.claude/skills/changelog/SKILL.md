---
name: changelog
description: Write a CHANGELOG entry from the commits since the last tag. One line per user-visible change.
---
# Changelog

1. List commits since the last tag: `git log $(git describe --tags --abbrev=0)..HEAD --oneline`.
2. Keep only changes a user would notice.
3. Write one line each, newest first, under a heading with the new version.
