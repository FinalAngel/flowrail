# Paper Plane: notes for Claude

Paper Plane is a local-first note app. The code is in `src/`, the plans in `docs/`.

## Areas

| Area | Router | Owns |
|---|---|---|
| Product | [docs/roadmap.md](docs/roadmap.md) | plans, decisions, what we learned |
| Engineering | [docs/architecture.md](docs/architecture.md) | the code and the agents that work on it |
| Release | [docs/release-checklist.md](docs/release-checklist.md) | playbooks and reports |

## Rules

- Never push without asking. Show the diff and wait for a yes.
- Never force push, and never rewrite history on `main`.
- Do not publish to npm. Releases follow `flowrail/workflows/release.md`.
- Keep `.env` files out of the repo.
- Every behavior change gets a test in `test/`.

## Style

- Small functions, plain names, no clever one-liners.
- Write docs in the second person.
