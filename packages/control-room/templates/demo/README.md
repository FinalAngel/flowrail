# Paper Plane

A small, fast note app that keeps every note as a Markdown file you own. Sync between devices is optional and end-to-end, and the app works fully offline.

## Install

```sh
npm install
npm run dev
```

Open http://localhost:5173 and start typing. Notes live in `~/PaperPlane` by default.

## Why another note app

- Notes are plain Markdown files. Close the app and they are still yours.
- Search is instant on ten thousand notes.
- Sync merges edits per paragraph, so two devices rarely conflict.

## Project docs

- [Roadmap](docs/roadmap.md)
- [Architecture](docs/architecture.md)
- [Decision 0001: store notes as Markdown](docs/decisions/0001-store-notes-as-markdown.md)
- [Release checklist](docs/release-checklist.md)

## Contributing

Small pull requests with a test are the easiest to merge. See the [roadmap](docs/roadmap.md) for what is planned.
