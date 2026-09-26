## What this changes

<!-- One or two sentences. Link the issue if there is one. -->

## How you checked it

<!-- The commands you ran. `npm test` and `npm run check` at minimum. -->

## Checklist

- [ ] `npm test` passes on Node 20 or later
- [ ] No new runtime dependency
- [ ] Nothing new is sent over the network
- [ ] Any command that changes files outside `flowrail/` or `.flowrail/` previews the change and asks first
- [ ] Docs updated if behavior or output changed (`docs/`, `CHANGELOG.md`)
- [ ] For a red line recipe: tests for the commands it must hold and the ones it must let through
