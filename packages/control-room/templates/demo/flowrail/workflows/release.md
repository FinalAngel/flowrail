# Release

How a Paper Plane version goes out. The agent prepares; a human publishes.

## Step 1: Freeze the scope

Check that every task labelled with the release is Done or moved to the next sprint. File anything left over with `npx @finalangel/flowrail-os task`.

## Step 2: Write the changelog

Use the changelog skill. One line per user-visible change, newest first. No internal refactors.

## Step 3: Bump the version

Update `package.json` and commit with the message `release: vX.Y.Z`.

## Step 4: SIGN-OFF on the release notes

Stop. The human reads the changelog and the diff since the last tag. Nothing below this step runs without a yes.

## Step 5: Tag and publish

The human pushes the tag and runs `npm publish`. Both are red lines, so the agent asks rather than acts.

## Step 6: Announce

Draft the release post as a doc in `docs/`. The human posts it.
