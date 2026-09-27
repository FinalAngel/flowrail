# Architecture

Paper Plane has three parts: the editor, the store and sync. Each one can be replaced without touching the others.

## Editor

A thin layer over a `contenteditable` element. It turns keystrokes into Markdown edits and never holds state of its own.

## Store

Every note is a file in the notes folder. The store watches the folder, keeps an in-memory search index and writes changes back within 300 ms. See [decision 0001](decisions/0001-store-notes-as-markdown.md).

## Sync

Sync compares two folders and merges them. Merges happen per paragraph: if two devices edit different paragraphs of the same note, both edits survive. If they edit the same paragraph, the newer edit wins and the older one is kept in a conflict note.

### Sync protocol

1. Each device keeps a vector clock per note.
2. On connect, devices exchange clocks and send only notes that changed.
3. The receiver merges paragraph by paragraph and writes the result.

## Where things live

The code is in `src/`. The agents that work on it are in `.claude/agents/`, their skills in `.claude/skills/`.

## Testing

Unit tests live next to the code. The sync tests run two stores against a shared temp folder. The team agrees that [[flaky-tests-go-to-quarantine]].
