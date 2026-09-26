# Extending flowrail

Three kinds of contribution come up most: a red line recipe, a dashboard page, and an adapter for an agent CLI other than Claude Code. This page covers each. The first two work today; adapters are planned, and the interface below is a proposal. Read [CONTRIBUTING.md](../CONTRIBUTING.md) for the general rules (zero dependencies, tests with `node --test`).

## Adding a red line recipe

A recipe is a red line that is useful beyond one project. Recipes live in two places:

- `packages/flowrail/examples/red-lines/<id>.json`, a single entry people can copy;
- `packages/flowrail/src/core/recipes.js`, which `flowrail init` uses to recognize a rule in someone's `CLAUDE.md` and offer the recipe.

An entry in the `RECIPES` array in `recipes.js` is the red line itself, plus a `detect` pattern. `flowrail init` pulls imperative rules ("never ...", "do not ...", "always ask before ...") out of `CLAUDE.md` and `AGENTS.md`, and offers the recipe when `detect` matches one:

```js
{
  id: 'no-publish-without-asking',
  title: 'Ask before publishing a package or release',
  why: 'A published version cannot be taken back.',
  severity: 'ask',
  hook: { tool: 'Bash', match: '^((npm|pnpm|yarn|bun) publish\\b|cargo publish\\b|twine upload\\b|gem push\\b|gh release create\\b|docker push\\b)' },
  // Tested against each imperative rule found in CLAUDE.md / AGENTS.md; not written to red-lines.json.
  detect: /\bpublish|\brelease\b/i,
}
```

`starter: true` marks the recipes every `init` adds without asking. `flowrail redlines add --list` prints the recipes, and `flowrail redlines add <id>` appends one to `red-lines.json`.

A recipe pull request needs tests for both directions: the commands it must hold, including the variants people type (`sudo`, a path prefix, a wrapper shell), and the ordinary commands it must let through. A recipe that fires on `npm run publish-docs` will be switched off by the first person who hits it. Name the known ways around it in the pull request, as [red-lines.md](red-lines.md#what-a-red-line-does-not-hold) does for the built-in ones. A change to a built-in matcher adds `HOLD`, `ALLOW` or `GAP` lines to its probe file in [test/corpus/](../packages/flowrail/test/corpus/).

Write `hook.match` against the normalized command (see [red-lines.md](red-lines.md#the-shell-parser)). If the normalizer is missing a case your recipe needs, fix it in `packages/flowrail/src/guard/shell.js` with a test rather than widening the regex.

## Adding a dashboard page

The UI is plain JavaScript modules with no build step. A page is one file:

```js
// packages/control-room/ui/pages/releases.js
export function mount(el, ctx) {
  const load = async () => {
    const data = await ctx.api('/releases'); // GET /api/releases; ctx.api adds the prefix and the X-Flowrail header
    el.replaceChildren(render(data));
  };
  load();
  ctx.on(['releases'], load); // live refresh; removed automatically when the page changes
  return () => {}; // unmount
}
```

`ctx.api(path, body)` sends a `GET`, or a `POST` when you pass a body. Then:

1. Add the page to `NAV` in `packages/control-room/ui/app.js` (`['releases', 'Releases', '/releases']` in the right group) and an icon to `ICON`.
2. If the page needs data, add a `'GET /api/releases'` entry to the routes in `packages/control-room/src/server.js`. Mutations are `POST` with an `_action` field; the server's host, origin and header checks apply to them automatically.
3. If the page reads a new file, map it to an area in `areaFor()` in `packages/control-room/src/core/events.js` so the page refreshes on change.
4. Build DOM with `document.createElement` and `textContent`. Never assign unescaped content to `innerHTML`.
5. Follow the tokens and components in `packages/control-room/ui/app.css`: one accent color, used for armed and active states only.

Every page needs an empty state that says what the page is for, shows the CLI command that fills it, and offers example data.

## Plugins: your own pages without a fork

A plugin adds pages and API routes to the control room from your own repo. It is an object:

```js
// room/crm.mjs
import path from 'node:path';
export default {
  id: 'crm',                                            // [a-z][a-z0-9-]*
  ui: path.join(import.meta.dirname, 'ui'),             // served at /x/crm/<file>
  pages: [{ id: 'leads', title: 'Leads', path: '/leads', group: 'Sales', icon: 'board', module: 'leads.js' }],
  routes: {
    'GET leads': (body, query, ctx) => readLeads(ctx.root), // GET /api/x/crm/leads
    'POST leads': (body, query, ctx) => saveLead(ctx.root, body),
  },
};
```

Load it one of two ways:

- **From config.** Add `"plugins": ["room/crm.mjs"]` to `flowrail/config.json` (paths inside the repo). `npx @finalangel/flowrail-room` imports them at start. The dashboard's settings API cannot set this field, and the guard asks before an agent edits `config.json`.
- **From code.** Start the server yourself, for example to load TypeScript through `tsx`:

  ```js
  import { startServer } from '@finalangel/flowrail-room/server';
  import crm from './room/crm.ts';
  await startServer({ root: process.cwd(), port: 4747, plugins: [crm] });
  ```

A plugin can also bring the data behind a built-in page. `stores: { board }` replaces `flowrail/board.json` for the Board page, the overview, the Today feed and search, so tasks can live in a tracker or a file of your own. A board store has `read()`, which returns `{ config: { current, next, sprints?, priorities?, groups?, source? }, tasks }` (a task's `sprint` is its sprint's start date, `""` the backlog; `priorities` in rank order replace P0 to P3; `groups` are `{ name, color }` shown as a chip and a filter), plus `create(fields)`, `update(id, fields, by)`, `note(id, text, by)` and `trash(id)`. A memory store (`stores: { memory }`) has `list()`, `recall(question, limit)` and `store(m)`, and optionally `trash(name)`; a memory whose `path` is `null` lives outside the repo. Throw an error with a `status` to answer the page with that status. Two plugins cannot supply the same store.

The page module (`ui/leads.js`) exports `mount(el, ctx)` exactly like a built-in page, and can import the shared helpers from `/ui/lib/dom.js` and `/ui/icons.js`. `ctx.api('/x/crm/leads')` reaches its routes. Routes get `ctx` with `root`, `paths`, `broadcast(area)` and `HttpError`, and sit behind the same Host, Origin, token and `X-Flowrail` checks as every built-in route. A page in a group that does not exist yet gets a new group above Safety. A page whose `path` equals a built-in page's path replaces it. Plugins run with your permissions in the server process, so load only code you would run yourself.

## Adapters for other agent CLIs

**Planned, not built.** Nothing below exists in the code yet: there is no `packages/flowrail/src/adapters/` folder, and hooks are installed for Claude Code only. This section is the proposed interface, written down so contributors can discuss it.

The files in `flowrail/` do not depend on Claude Code. The dashboard, board, docs, comments, memory, recall and `flowrail check` work with any agent, or none. What is specific to Claude Code is how the hooks are installed and the format of the events they receive.

An adapter would be the part that translates. The proposal: adapters live in `packages/flowrail/src/adapters/<name>.js` and export:

```js
export default {
  name: 'example-cli',

  // Is this CLI configured in the project? Used by init and doctor.
  detect(root) {},

  // Add or remove hook configuration. Return a preview (file, before, after)
  // so the CLI can show the diff and ask before writing.
  install(root, { command }) {},
  uninstall(root) {},
  status(root) {},

  // Turn the CLI's pre-tool event (parsed stdin) into flowrail terms.
  // tool is mapped onto flowrail names where one exists: Bash, Write, Edit.
  parseEvent(event) { return { tool, input, cwd, session }; },

  // Turn a decision into what the CLI expects on stdout.
  // decision: { severity: 'block' | 'ask' | 'warn' | null, id, title, why }
  formatDecision(decision) { return { stdout, exitCode }; },
};
```

The red line evaluation itself (normalizing, matching, picking the most severe, logging) is shared. An adapter only reshapes input and output, so the same `red-lines.json` holds under every CLI that has a pre-tool hook.

Candidates: Codex CLI, Gemini CLI and opencode. For each, the first question is whether it has a hook that runs before a tool call and can refuse it. If it only has a hook after the fact, the adapter can still log and warn, and the docs must say that it cannot block.

An adapter pull request should include a test that feeds recorded events from that CLI through `parseEvent` and checks `formatDecision` against the format its documentation describes.

The interface will change once the first adapter meets a real CLI. Open a discussion before starting on one, so two people do not build the same adapter.

## The flowrail package from code

`flowrail` exports one module, `flowrail/api` (also the package root): the surface the control room builds on, and the only one with a stability promise. Everything else under `src/` is internal.

```js
import { testCommand, verifyRedlines, describeRedlines, loadLines, hooksStatus, driftStatus, auditSummary, stateDir } from 'flowrail/api';

testCommand('/path/to/repo', { subject: 'git push --force' }); // { decision: 'deny', line, what, reason, normalized }
verifyRedlines('/path/to/repo');                               // { ok, lines, held, allowedAsExpected, failed, probes }
```

`testCommand` asks the guard what it would do with one call, as the hook would, without logging it. The rest: red-line helpers (`loadLines`, `validateLines`, `weakenings`, `logChange`, `holds`, `changes`, `stats`, `runChecks`), setup (`planInit`/`planGuardSetup`, `applyPlan`, `freshEpoch`), the journal (`appendJournal`, `verifyJournal`, `journalPath`), comment signatures, and the small file and CLI helpers the control room shares. `decision` is Claude Code's word (`deny`); people read it as "block".
