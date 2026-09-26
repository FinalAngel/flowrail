# 0001: Store notes as Markdown files

Status: accepted

## Context

Note apps that keep notes in a database make leaving hard. Our users asked, more than anything else, to own their notes.

## Decision

Every note is one `.md` file in a folder the user picks. Metadata that Markdown cannot hold (pinned, color) goes in a small frontmatter block.

## Consequences

- Any editor can open the notes. Git works on them.
- Search needs its own index, rebuilt from the files on start.
- Renames and moves happen on disk, so the store must watch the folder.
