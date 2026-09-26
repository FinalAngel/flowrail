# Red-line probe corpus

One file per built-in matcher. Each line is `HOLD <call>` (the matcher must hold it) or
`ALLOW <call>` (it must not). A call is a Bash command, or `Tool: path` for a file tool
(`Write: .env`, `Read: config/.ENV`), or a tool name and its input as JSON
(`mcp__github__push_files {"repo":"app"}`, `Write {"file_path":"a.js","content":"..."}`). Lines starting with `#` are comments. A line starting with
`|` continues the call above it on a new line (heredocs, line continuations).

Every probe runs in a project at `/work/project` with the shell in that folder, against that one
builtin (without the protect-flowrail floor). `protect-path` probes use the glob `content/**`.
Attacks that take two steps (write a symlink, then write through it) need a real folder: they
live in test/chains.test.js, and every tamper path is listed in docs/tamper-model.md.
`node --test` runs them all (test/corpus.test.js); `node scripts/corpus-stats.js` counts them.
Found a bypass? Add a `HOLD` line that fails, then fix the matcher.
