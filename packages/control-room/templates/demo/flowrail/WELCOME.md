# Welcome to the Paper Plane example

This is a sample flowrail workspace for a small open-source note app. It lives in a temp folder and nothing here touches your repo. Click around, leave comments, move cards. Run `npx @flowrail/control-room demo` again for a fresh copy.

## Things to try

- Open **Red lines** and type `sudo git -C . push origin main` into the tester. It is held, even with the wrapper and the `-C` flag.
- Open **Board**. Two cards were filed by an agent; one rolled over from last sprint and moved up a priority.
- Open **Docs**, select a sentence in `docs/roadmap.md` and press Comment. In a real project, the next Claude Code session picks it up.
- Open **Memory** and ask "why do we merge per paragraph".
- Open **Routines**. The weekly digest failed last Monday; the first line of its log says why.

## How this maps to your project

Run `npx flowrail init` in your own repo for the guard alone, or `npx @flowrail/control-room init` for the guard plus this dashboard. It shows every file it will add or change and asks before writing anything.
