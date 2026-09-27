# Contributing

Thank you for considering it. The most valuable pull request for flowrail is a red line: one rule that other people also want enforced, with tests. After that, adapters for other agent CLIs. Bug reports with a reproduction come a close third.

## Ground rules

These are the promises flowrail makes to its users. A change that breaks one will not be merged, however useful it is.

- **No runtime dependencies.** Node 20 standard library only. If you need a small algorithm (a glob matcher, a force layout), write it.
- **No build step.** Plain JavaScript ES modules. JSDoc types are welcome; TypeScript compilation is not.
- **Nothing leaves the machine.** No telemetry, no update checks, no external fonts or scripts in the UI.
- **State is plain files.** Anything flowrail stores goes in `flowrail/` (committed) or `.flowrail/` (per machine) as JSON or Markdown.
- **Ask before touching the user's files.** Any command that changes a file outside those two folders previews the diff and asks, unless `--yes`.
- **The hook never crashes and stays fast.** `flowrail hook pre-tool-use` runs before every tool call. Keep its import graph small.

## Setup

```sh
git clone https://github.com/FinalAngel/flowrail
cd flowrail
npm install                  # links the two workspace packages; no dependencies
npm test                     # node --test in packages/flowrail and packages/flowrail-os
node packages/flowrail-os/bin/flowrail-os.js demo   # dashboard on a seeded example workspace
npm run check                # the repo's own red lines
```

Two packages: `packages/flowrail` (the guard, published as `flowrail`) and `packages/flowrail-os` (the dashboard, published as `@finalangel/flowrail-os`).

## Contributing a red line

1. Add the entry as `packages/flowrail/examples/red-lines/<id>.json`.
2. If `flowrail init` should offer it when someone's `CLAUDE.md` contains the rule, add it to `packages/flowrail/src/core/recipes.js` with the phrases that trigger it.
3. Add tests: the commands it must hold (with the variants people type) and the ordinary commands it must let through.
4. In the pull request, list the ways around it you know of.

[docs/extending.md](docs/extending.md#adding-a-red-line-recipe) has the details and an example. The [red line recipe issue form](https://github.com/FinalAngel/flowrail/issues/new?template=red-line-recipe.yml) is a good place to discuss one before writing it.

## Contributing an adapter

flowrail's files are agent-agnostic; its hooks are not yet. An adapter makes red lines hold under another CLI. Start a discussion first, then see [docs/extending.md](docs/extending.md#adapters-for-other-agent-clis).

## Pull requests

- One change per pull request. Small ones get reviewed first.
- Add or update tests. Security gates and hook decisions always need them.
- Update the docs in `docs/` and add a line to `CHANGELOG.md` under the top, unreleased version if behavior or output changes.
- Use sentence case and plain words in UI text and docs. No exclamation marks, no emoji, and no spaced em or en dashes.
- Commit messages: a short imperative summary line, then the why if it is not obvious.

## Releasing

Maintainers release both packages together, at one version:

1. Set `version` in `packages/flowrail/package.json` and `packages/flowrail-os/package.json`, and the dashboard's `flowrail` dependency, to the new version; run `npm install` to update the lockfile.
2. Date the top section of `CHANGELOG.md` as `## [X.Y.Z] YYYY-MM-DD`.
3. Commit, push to `main`, then `git tag vX.Y.Z && git push origin vX.Y.Z`.

The [release workflow](.github/workflows/release.yml) checks that the tag, both versions and the changelog agree, runs the tests, publishes the guard and then the dashboard to npm with provenance, and opens a GitHub release with that version's changelog section. npm trusts the workflow directly (trusted publishing), so there is no npm token in the repository.

## Reporting bugs

Use the [bug form](https://github.com/FinalAngel/flowrail/issues/new?template=bug.yml) and include the output of `npx flowrail doctor`. For security issues, see [SECURITY.md](SECURITY.md) instead.

By contributing you agree that your work is released under the [MIT license](LICENSE), and to follow the [code of conduct](CODE_OF_CONDUCT.md).
