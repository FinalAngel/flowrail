---
name: add-context
description: Adds a source (a book, a course, an article, a talk, a standard) to the project's Context library so agents can draw on it. Use when asked to "add this to context", "read this and keep notes", or to index a source for later.
---

# Add a source to the Context library

The Context library is one folder per source under `flowrail/context/` (or the folder `contextDir` names in `flowrail/config.json`). The dashboard's Context page lists them.

1. Pick a short slug for the source (`clean-architecture`, `iso-27001-2022`) and create `<contextDir>/<slug>/`.
2. Write `<contextDir>/<slug>/index.md` with frontmatter and a short overview:

   ```markdown
   ---
   title: The full title
   source: https://where-it-lives.example
   summary: One or two sentences on what the source is and why it matters here.
   ---

   # The full title

   What it covers, who wrote it, and the parts that matter for this project.
   ```

3. Put notes beside it as separate files (`<contextDir>/<slug>/<topic>.md`), one topic per file, each short enough to read in a minute.
4. Keep it short and in your own words. Cite the source (a URL, a chapter, a page). Quote only a sentence or two where the exact words matter, and never paste whole passages of copyrighted text.
5. Say what you added: the folder and the files.
