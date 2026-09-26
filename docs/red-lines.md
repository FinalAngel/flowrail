# Red lines

A red line is one of your hard rules, written down once in `flowrail/red-lines.json` and enforced in two places: a hook that runs before Claude Code uses a tool, and a check that scans files in the repo. This page is the reference for both.

A red line is a seatbelt, not a jail. It holds the ordinary, direct form of an action, including the variants people and agents type without thinking about it. It does not hold a determined attempt to get around it. [What a red line does not hold](#what-a-red-line-does-not-hold) lists the gaps, and every claim on this page is backed by a probe in [test/corpus/](../packages/flowrail/test/corpus/).

## The file

`flowrail/red-lines.json` is a JSON array. Each entry is one rule.

```json
[
  {
    "id": "no-push-without-asking",
    "title": "Never push without asking",
    "why": "Pushing publishes work. A human decides when.",
    "severity": "ask",
    "hook": { "tool": "Bash|mcp__*", "builtin": "git-push" }
  },
  {
    "id": "no-deploy-without-asking",
    "title": "Ask before deploying",
    "why": "Deploys change what users see. A human presses the button.",
    "severity": "ask",
    "hook": { "tool": "Bash", "match": "^(npm|pnpm|yarn|bun) run deploy\\b" }
  }
]
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable kebab-case identifier. It appears in hook messages, the log and the dashboard. |
| `title` | yes | The rule in plain words. The dashboard quotes it verbatim, so write it the way you would say it. |
| `why` | no | One or two sentences. Claude sees this when the hook fires, which is often enough for it to choose a different approach on its own. For a regex line it is also the plain-English summary on the dashboard. |
| `severity` | yes | `block`, `ask` or `warn`. See below. |
| `hook` | no | Enforcement before a tool call: a `builtin` or a `match`. |
| `hook.builtin` | one of the two | A built-in matcher: `git-push`, `git-destructive`, `rm-dangerous`, `secret-files`, `flowrail-tamper`, `mcp-actions`, `email-send`, `payments`, `publish-deploy`, `infra-destructive`, `db-destructive`, `protect-path`, `command` or `file-field`. See [Built-in matchers](#built-in-matchers). |
| `hook.params` | for `protect-path`, `command` and `file-field` | Parameters for a builtin: `protect-path` takes `{ "glob": "content/**" }` (add `"edits": true` to hold changes in place too); `command` takes `{ "argv": ["git", "commit"], "flags": ["--no-verify"] }`; `file-field` is described [below](#file-field). |
| `hook.match` | one of the two | A JavaScript regular expression tested against the tool's subject. |
| `hook.tool` | yes for `match`; defaults to `*` for `builtin` | `*`, one tool name (`Bash`), or several joined with `\|` (`Write\|Edit`). A builtin only looks at the tools it knows, so `*` is fine. |
| `hook.flags` | no | Regular expression flags for `match`, for example `"i"`. |
| `hook.raw` | no | `true` tests `match` against the raw command instead of the parsed one. Bash only. |
| `check` | no | Enforcement over files in the repo, run by `flowrail check`. |
| `check.glob` | no | Which files to scan, for example `**/*.md`. Defaults to `**/*`. |
| `check.pattern` | yes, in `check` | A regular expression tested against each line of each file. |
| `check.flags` | no | Regular expression flags for `pattern`. |
| `check.message` | no | What to print next to each hit. Defaults to `title`. |
| `probes` | no | `{ "hold": [...], "allow": [...] }`: calls `flowrail redlines verify` runs against this line on top of flowrail's own probes. A string is a Bash command; `{ "tool": "Edit", "input": { "file_path": "…" } }` is any other tool. `flowrail init` writes them from the commands and paths your `CLAUDE.md` rule quotes. |

## States

Every red line is in exactly one state. The CLI (`flowrail redlines`, `flowrail-room status`), the dashboard and the API (`state` on each entry of `GET /api/redlines`) use the same four, computed from one function:

| State | Label | When | What it means |
|---|---|---|---|
| `armed` | Armed | it has a `hook`, and the flowrail hooks are installed and healthy | Held at runtime, before the tool runs. |
| `checked` | Checked in CI | it has a `check` and no `hook` | Enforced by `flowrail check` over the files, in CI or by hand. Nothing holds it at runtime. |
| `declared` | Declared only | neither `hook` nor `check` | Written down, not enforced. Valid, and a reminder to add one. `flowrail init` writes your CLAUDE.md rules that no recipe covers this way. |
| `not-enforced` | Not enforced | it has a `hook`, but the guard is not live | The rule looks enforced and is not. The only state shown in red. |

"Live" means every flowrail hook event is in `.claude/settings.json`, the hooks call the vendored guard in `.claude/flowrail/guard/`, and every guard file matches its manifest and the guard shipped in the flowrail you are running. See [hooks.md](hooks.md#healthy-means-verified). `flowrail doctor` says which part is wrong.

**The floor.** `protect-flowrail` is compiled into the guard and always active. `GET /api/redlines` lists it with `"floor": true` even when `red-lines.json` leaves it out, and the CLI marks it "built in, always on". Your file can raise it to `block`; it cannot remove it or lower it. A `red-lines.json` that is an empty array is valid: then only the floor holds anything, and `flowrail doctor` warns "0 lines of your own".

**The dashboard can only tighten.** Saving red lines through the dashboard API accepts new lines, a higher severity, and a hook or check added to a line that had none. Removing a line, lowering its severity, or changing or removing its hook or check is refused with 409 "Edit flowrail/red-lines.json yourself to weaken a rule (the agent will be asked first)." An agent that finds the dashboard token can add rules, never switch one off.

A red line with both a hook and a check is `armed` (or `not-enforced`); its check still runs in `flowrail check`.

## Severities

| Severity | Hook decision | `flowrail check` |
|---|---|---|
| `block` | The tool call is denied. Claude sees the reason. | Hits fail the run (exit 1). |
| `ask` | Claude Code asks you to approve the call, showing the reason. | Hits are printed; exit 0. |
| `warn` | The call goes ahead; Claude sees a system message. | Hits are printed; exit 0. |

When several red lines match one tool call, the most severe wins: `block` over `ask` over `warn`.

A builtin can ask for less than its line's severity: `git-destructive` blocks a force push but only asks before deleting a remote branch. A line's severity is a ceiling, so a `git-destructive` line with severity `ask` asks for everything and never blocks.

What `ask` does depends on how Claude Code runs: with permissions bypassed it depends on the version, and in auto mode Claude Code's own classifier answers the ask, not you. If a rule must hold in every mode, make it `block`.

## When something is wrong: fail closed

Inside a flowrail workspace the hook never turns its own trouble into "allowed":

- `red-lines.json` is missing, is not JSON, or is not an array: every tool call becomes an ask with the reason `flowrail: red-lines.json could not be read (…). Fix it or run flowrail doctor.`, and the same line goes to stderr.
- A red line's regex does not compile, or its builtin is unknown: that line asks on every call to its tools, and says why.
- The hook input cannot be parsed, or the hook itself fails: ask.
- A guard file or its manifest is missing, emptied, garbled or changed, or `node` is not on the PATH: the hook command exits 2 and Claude Code blocks the call (see [hooks.md](hooks.md#what-gets-installed)).
- `red-lines.json` or `config.json` changed outside flowrail: every call asks, and a call the last accepted red lines block stays blocked.

Red lines come from the project (`$CLAUDE_PROJECT_DIR`) and from every other `flowrail/` workspace between it and the call's folder: a nested workspace adds lines, never removes any. Outside any workspace, and with no vendored guard in the project, the hook has no opinion. The hook reads its input as a stream to the end, so a slow writer, as in `(sleep 0.5; echo '{…}') | flowrail hook pre-tool-use`, gets the same decision as a fast one.

## Built-in matchers

A regex over a whole command line is a poor fit for flags. `git push -uf`, `git push origin +main` and `git clean -nf` (a dry run) all defeat a regex written for `--force`. The builtins parse each command into argv first (see [the shell parser](#the-shell-parser)) and then look at subcommands and flags the way the program does. Each one has a public probe file: `HOLD` lines it must hold, `ALLOW` lines it must let through, `GAP` lines it is known to miss. `node packages/flowrail/scripts/corpus-stats.js` counts them; CI runs them all.

### `git-push`

Holds any push to a remote: `git push` with any options, `git send-pack`, `git subtree push`, `hub push`, `gh repo sync`, `jj git push`, the `git-push` program itself, a git alias for push (`git -c alias.p=push p`, `git config alias.p push` when it is set, and an alias already in the repo's `.git/config` or your `~/.gitconfig`, read when the command runs), and the same inside `sh -c`, `eval`, `find -exec`, heredocs and `echo … | sh`. It is an exact subcommand match, so `git push-to-checkout`, `git push-docs` and `git stash push` are not pushes.

`git push --dry-run` and `git push -n` send nothing and are let through. `git${IFS}push`, `perl -e "system q(git push)"`, `awk 'BEGIN{system("git push")}'` and `ruby -e 'system("git push")'` are held (see [the shell parser](#the-shell-parser)).

Also held: writes to refs through the GitHub API (`gh api -X POST|PATCH|DELETE …/git/refs/…`, or with `-f`/`-F` fields), the wrappers `xcrun`, `arch -arm64`, `script -q /dev/null …` and `bash <(echo git push)`, and, for the recipe's `"tool": "Bash|mcp__*"`, repository writes on a git host's MCP server (`mcp__github__create_or_update_file`, `push_files`, `delete_file`, `create_branch`, `merge_pull_request`, `update_pull_request_branch`, on any server named like github, gitlab, bitbucket, gitea or forgejo).

It asks (it cannot tell) when git's subcommand comes from a pipe (`printf push | xargs git`, `xargs -I{} git {}`) or a variable (`x=push; git $x`), or when the program itself is a variable or a substitution followed by `push` (`$GIT push`, `$(printf git) push`).

Summary on the dashboard: "Asks before any git push (also git send-pack, git subtree push, hub push, gh repo sync, and git aliases that push)".

### `git-destructive`

| Held as `block` | |
|---|---|
| force push | `-f`, `--force`, `--mirror`, any short-flag group containing `f` (`-uf`), a `+` refspec (`origin +main`), a forced ref update through `gh api -X PATCH …/git/refs/… -F force=true` |
| hard reset | `reset --hard` |
| forced clean | `clean` with `-f`/`--force` (or a group containing `f`), unless `-n`/`--dry-run` is also there |
| forced branch delete | `branch -D`, `branch -d -f`, `branch --delete --force` |
| discarding all local changes | `checkout -f`, `checkout .`, `checkout -- .`, `restore .` or `restore :/` (unless only `--staged`), `switch -f`, `switch --discard-changes` |
| other | `stash drop`, `stash clear`, `update-ref -d`, `filter-branch`, `filter-repo`, `reflog expire`, `reflog delete`, `gc --prune=now`, `worktree remove --force` |

| Held as `ask` | |
|---|---|
| force push with lease | `--force-with-lease[=…]`, `--force-if-includes`: it only overwrites what this clone last saw on the remote, so it asks instead of blocking |
| deleting a remote branch | `push --delete`, `push -d`, `push origin :branch`, `push --prune`, `gh api -X DELETE …/git/refs/…` |
| moving a branch | `branch -f main HEAD~5`, `branch --force main <rev>`: the branch's newer commits drop off it |
| reset --merge | it can drop uncommitted changes in files the merge touched |
| a subcommand from a pipe or a variable | `echo reset --hard \| xargs git`, `x=reset; git $x --hard` |

Let through: `git push --force --dry-run`, `git reset --keep HEAD~3` (it refuses to drop uncommitted changes, and the commits it moves the branch off stay in the reflog, as with `--soft` and `--mixed`), `git branch -d` (git refuses to delete an unmerged branch), `git clean -n`, `git clean -nf`, `git reset --soft`, `git checkout -- <file>`, `git restore --staged .`. Aliases in `.git/config` and `~/.gitconfig` are expanded, so `git nuke` for `reset --hard` is held.

Long options match by any prefix, the way git reads them: `reset --har`, `reset --ha`, `clean --forc`, `branch --del --forc`, `push --forc` are the full options. A prefix that could mean several options is held too; git refuses to run it anyway. Options that make a command safe (`--dry-run`, `--keep`, `--staged`) count only when spelled out.

### `rm-dangerous`

Holds `rm` with a recursive flag (`-r`, `-R`, `--recursive`, in any spelling or order, with or without `-f`) when any target is `/`, your home folder (`~`, `$HOME`, `${HOME}`), everything (`*`, `.*`, `.`, `./`, `./*`, `..`), the project folder itself, the project's `.git`, a top-level system folder, or anything else that resolves outside the project. Relative paths are resolved from the session's working folder, following `cd` earlier in the same command, so `cd .. && rm -rf project` is held. Deleting inside the project is fine: `rm -rf dist`, `rm -rf node_modules`, `rm -rf content/`. So is deleting inside a temp folder (`/tmp/x`, not `/tmp` itself), unless that folder is the project or one of its parents: for a project in `/tmp/a/b/app`, `rm -rf ../..` is held. A target set by a variable or a substitution (`rm -rf $DIR`) asks. Symlinks are followed the way `rm` follows them: `rm -rf link/` and `rm -rf link/*` are judged by where the link points (so `ln -s ~ /tmp/h && rm -rf /tmp/h/` is held, in one command or two), while `rm link` only removes the link and is fine.

The same goes for the node deleters `rimraf`, `del-cli`, `del`, `trash` and `premove`, run directly or through `npx`, `bunx`, `pnpx`, `pnpm dlx`, `npm exec` or `yarn dlx` (`npx rimraf ~` is held, `npx rimraf dist` is fine), and for an inline script that deletes the home folder or `/` by name: `ruby -e 'FileUtils.rm_rf(Dir.home)'`, `node -e "fs.rmSync(os.homedir(), …)"`, `python3 -c "shutil.rmtree(os.path.expanduser('~'))"`, `perl -e 'remove_tree($ENV{HOME})'`. It asks before `eval "$(…)"` and any command whose program is a command substitution (the command is only known when it runs), and before `docker run`, `podman run` or `nerdctl run` with your home folder or `/` mounted (`-v ~:/h`, `--mount source=/,…`) and a delete (`rm`, `find`, `shred`, `dd`, `mkfs`) in the container's command.

It also holds `find … -delete` and `find … -exec rm` when the search starts outside the project (or at the project with nothing filtering it), `rsync --delete` into home, `/` or outside the project, `mv ~ …`, `mv / …` or `mv <project> …` and `mv anything /dev/null`, and wiping a disk: `dd of=/dev/disk*` (and `rdisk`, `sd*`, `nvme*`, …), a redirect onto a disk device, `mkfs*`, `newfs*`, `wipefs`, `diskutil eraseDisk|eraseVolume|zeroDisk|…`, `sgdisk --zap-all`.

### `secret-files`

Secret names, case-insensitive: `.env` and `.env.*` (but not `.env.example`, `.env.sample`, `.env.template`; `cp .env.example .env` is fine, since the secrets go in later through a write that is held), `.envrc`, `*.env`, `id_rsa`, `id_ed25519` and the other `id_*` keys (not `*.pub`), `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`, `*.keystore`, `service-account*.json`, `kubeconfig*`, `.npmrc`, `.netrc`, `.pgpass`, `credentials`. A glob that would match one counts (`cat .e*`, `cat *.pem`); plain `*` does not. So does a symlink to one, made earlier or in the same command (`ln -s .env envlink; cat envlink`, `Read envlink`): paths are compared with symlinks resolved.

| | `block` (write) | `ask` (read) |
|---|---|---|
| File tools | Write, Edit, MultiEdit, NotebookEdit on a secret name | Read, and Grep with a secret `path` |
| Bash | a redirect into it (`>`, `>>`, `>\|`, `&>`), `tee`, `truncate`, `dd`, `sed -i`, `perl -i`, `cp`/`mv`/`install` onto it, `git add` of it | `cat`, `less`, `head`, `tail`, `grep`, `source`, `.`, `base64`, `awk`, `cp` from it, `scp`, `curl -F @…`, `git show`/`diff`/`log` of it, `< .env`, an inline `python -c` or `node -e` that names it |
| MCP tools | a write tool (`write_file`, `edit_file`, `move_file`, ...) whose `path` is a secret name | a read tool whose `path` is a secret name |
| Grep | | a `glob` that matches a secret name (`.env*`, `*.pem`) |
| environment | | `env`, `printenv`, `set` or `export -p` with no arguments (they print every variable, tokens included); `env \| grep NODE_ENV` is fine, `env \| grep -i token` is not; `echo`/`printf`/`printenv` of a variable whose name looks secret (`$OPENAI_API_KEY`, `${GITHUB_TOKEN}`: `*KEY*`, `*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*CREDENTIAL*`, `*PRIVATE*`); an inline script that prints `os.environ`, `process.env` or `%ENV` whole or reads a secret-looking variable |
| credential CLIs | | `gh auth token` (and `gh auth status --show-token`), `security find-generic-password -w`/`-g`, `security dump-keychain`, `op read`, `op item get --reveal`, `aws configure get`, `aws configure export-credentials`, `gcloud auth print-access-token`, `az account get-access-token`, `heroku auth:token`, `git credential fill`, `vault read`, `doppler secrets` |

**Secret content.** Write, Edit, MultiEdit, NotebookEdit, MCP write tools, and shell writes (`echo … > file`, a heredoc into a file, `tee`) are scanned for high-confidence secret formats and blocked with the name of what was found: AWS access keys (`AKIA…`, `ASIA…`), GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`, `github_pat_`), Slack tokens (`xox[baprs]-`), Stripe live keys (`sk_live_`, `rk_live_`), Anthropic and OpenAI keys (`sk-ant-…`, `sk-proj-…`, `sk-…` with 32 or more characters), Google API keys (`AIza…`), and private key headers. A key ending in `EXAMPLE` (AWS's documented sample) is let through. `flowrail check` runs the same scan over every file in the repo; a file of test fixtures can opt out of that scan (not of the hook) with `flowrail:allow-secrets` in a comment in its first five lines.

### `flowrail-tamper`

The self-protection matcher. It backs the built-in floor `protect-flowrail` (severity `ask`, always active; see [the floor](#states)). It holds:

- Write, Edit, MultiEdit, NotebookEdit and MCP filesystem write tools on anything the guard depends on, however the path is spelled (absolute, relative, `..`, different case, through a symlink, or as a glob the shell expands):
  - `flowrail/red-lines.json`, `flowrail/config.json`, `flowrail/routines.json`;
  - `.claude/settings.json`, `.claude/settings.local.json` and any other `.claude/settings*.json`;
  - `.claude/flowrail/**` (the vendored guard) and `.flowrail/**` (the log, comments, runs);
  - `.git/config` (an alias defined there runs later under another name) and `.git/hooks/**` (code git runs on your next commit);
  - `.mcp.json` (which MCP servers load);
  - `node_modules/flowrail/**` and `node_modules/.bin/flowrail`;
  - scripts your own hooks run: any file a hook command in `.claude/settings*.json` names (`.claude/hooks/check.sh`);
  - files the next shell, git, ssh or agent session loads: `~/.zshenv`, `~/.zshrc`, `~/.zprofile`, `~/.zlogin`, `~/.bashrc`, `~/.bash_profile`, `~/.bash_login`, `~/.profile`, `~/.config/fish/**`, `~/.gitconfig`, `~/.config/git/**`, `~/.ssh/config`, `~/.ssh/authorized_keys`, `~/.ssh/rc`, `~/.ssh/environment`, `~/.claude/settings.json`, `~/.claude/settings.local.json` (and moving `~/.ssh` away);
  - `settings.json` and `settings.local.json` in `$CLAUDE_CONFIG_DIR` when Claude Code runs with it set (read from the hook's environment; `"$CLAUDE_CONFIG_DIR/settings.json"` spelled with the variable is held even when it is not set);
  - the machine-local journal and signing key (`~/Library/Application Support/flowrail/`, `~/.local/state/flowrail/` or `$XDG_STATE_HOME/flowrail/`);
- **`disableAllHooks` in any file anywhere**: a Write, Edit or MCP write whose new content sets it (`"disableAllHooks": true`), and any shell command that writes it (`jq '.disableAllHooks = true' … > …`, a heredoc, `sed -i`, `claude config set disableAllHooks true`). Mentioning it in prose, or `grep disableAllHooks`, is fine;
- the managed block in `CLAUDE.md` and `AGENTS.md`: a Write whose new content drops or changes the block between `<!-- flowrail:start -->` and `<!-- flowrail:end -->`, an Edit whose replacement touches it, and shell overwrites or `sed -i` of a file that has it (appending with `>>` is fine);
- shell commands that write, move, link or delete those paths: redirects, `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `ln` and `ln -s` (to or over a protected path, or to a folder that holds one), `install`, `rm`, `truncate`, `dd of=`, `chmod`, `git checkout`/`restore`/`rm`/`mv`, `rm -rf flowrail`, `.claude` or `.flowrail`, and inline scripts that name them;
- **any other program that names a protected file**, unless it only reads (`cat`, `less`, `head`, `grep`, `jq`, `diff`, `ls`, `sed` without `-i`, `git diff`/`log`/`show`/`add`/`commit`, `flowrail …`): editors (`vim -c`, `ed`, `ex`, `emacs --batch`, `nano`), `touch`, `awk`, a script given the path, `git update-index --cacheinfo …,flowrail/red-lines.json`;
- **globs, loops and file lists**: a glob is expanded against the disk and against every protected path before the check (`cp /dev/null .claude/*/*/hook.mjs`, `rm flowrail/red-lines.*`, `{a,b}` included; like the shell, `*` does not match a leading dot); `for f in …; do … "$f"; done` and `f=…; … $f` fill in the variable; a file list piped from `find`, `fd`, `git ls-files`, `grep -l`/`rg --files`, `ls` or `echo` into `xargs <program>` or `while read f; do …` is checked as if the paths were written out;
- **copied trees**: `cp -r`, `cp -a`, `rsync`, `mv` and `ditto` into the project (or a folder above flowrail files) of a folder named like a protected one (`cp -r /tmp/x/.claude .`), or of a tree's contents (`rsync -a /tmp/x/ ./`, `cp -a /tmp/x/. .`) that holds a protected file, or may (a remote source, a glob). Copying a local tree without one is fine;
- **writers that do not name the file**: `tar -x`, `bsdtar`, `unzip`, `7z x`, `cpio -i` and `pax -r` extracting into the project, a parent of it or a flowrail folder (unless they list only ordinary members); `patch` and `git apply` whose diff targets a protected file, or whose diff the guard cannot read (a pipe); `git checkout-index -a`, `git read-tree -u`, `git restore --source=<rev>` and `git checkout <rev> --` over `.`, `:/` or a flowrail folder; `find -delete`, or `-exec` of a program that writes, whose start folders and `-name`/`-path`/`-regex` filters reach a flowrail file (`find . -name '*.js' -delete`, `find .claude -exec sed -i …`; `find . -type f -exec wc -l {} +` only reads and is fine; `.flowrail/` is left to the journal, so `find . -name '*.log' -delete` is not asked). `git stash pop`, merges and branch checkouts are not asked: drift detection (below) catches what they change;
- **git configuration that runs programs** later, set by `git config` (any scope, `set`, `--edit`), `git -c key=value`, `--config-env`, `GIT_CONFIG_KEY_<n>`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` (inline or `export`ed), or a write to `~/.gitconfig`: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.pager`, `pager.*`, `core.editor`, `sequence.editor`, `diff.external`, `diff.*.textconv`, `diff.*.command`, `merge.*.driver`, `filter.*.clean|smudge|process`, `credential.helper`, `alias.*`, `include.path`, `includeIf.*.path`, `core.askPass`, `gpg.program`, `gpg.ssh.defaultKeyCommand`, `hook.*.command`, `hookcmd.*.cmd`, `uploadpack.*`/`receivepack.*`. `git config user.name`, `git -c color.ui=always` and reading config are fine;
- **environment that git runs as a program**: `GIT_SSH`, `GIT_SSH_COMMAND`, `GIT_EDITOR`, `GIT_SEQUENCE_EDITOR`, `GIT_PAGER`, `GIT_EXTERNAL_DIFF`, `GIT_PROXY_COMMAND`, `GIT_ASKPASS`, `SSH_ASKPASS`, `GIT_EXEC_PATH`, `GIT_TEMPLATE_DIR`, in front of a command, through `env`, or `export`ed, and `PAGER` in front of a git command (`PAGER=less man ls` is fine);
- **reading the machine-local state** (the comment key, the journal, the accepted snapshots) with any program or the Read tool, so a key cannot be taken to sign a forged comment;
- scripts that reach for the guard: a Write of a `.js`, `.mjs`, `.ts`, `.py`, `.sh`, `.rb`, `.pl` or `.php` file (or a heredoc into one) whose content names a protected path or calls the dashboard's port on a loopback address, and running a script file (`node t.mjs`, `bash run.sh`, `./run.sh`) whose content does;
- `flowrail uninstall`, `flowrail hooks install|uninstall`, `flowrail routines install` and `flowrail redlines accept`, however flowrail is invoked, plus `npm uninstall flowrail`;
- calls to the dashboard API: `curl`, `wget`, `http`/`xh`, `nc`, `socat`, `/dev/tcp`, and inline scripts (`python -c "urllib…"`, `node -e "fetch(…)"`), aimed at a loopback address (`127.0.0.1`, `127.1`, `localhost`, `[::1]`, `0.0.0.0`, `0`) on the configured port, the ten after it, or any port a running dashboard lists in `<state>/ports.json`.

Reading those files, `rm -rf node_modules` (the guard does not live there), `flowrail status`, `flowrail redlines test` and ordinary tasks are fine.

**Drift detection.** On top of the matcher, the hook compares `flowrail/red-lines.json` and `flowrail/config.json` with the last version flowrail accepted, and asks on every call while they differ, whoever changed them; the last accepted red lines still apply meanwhile, so what they block stays blocked. See [hooks.md](hooks.md#pre-tool-use) and [tamper-model.md](tamper-model.md#the-backstop-drift-detection).

### `mcp-actions`

Used by the starter line `ask-before-mcp-actions` (`"tool": "mcp__*"`, severity `ask`). Claude Code names MCP tools `mcp__<server>__<tool>`. The matcher splits the tool part into words (`send_message`, `postMessage`, `slack_post_message`) and holds a tool whose first word, or whose second word after a non-read first word, is one of: send, post, publish, push, merge, delete, remove, trash, release, create_release, deploy, transfer, pay, charge, refund, invite, share, forward, reply, submit, approve, close, archive, drop. Read tools (`get_…`, `list_…`, `search_…`, `read_…`, `fetch_…`) are never held, so `get_merge_status` is fine. Examples held: `mcp__github__push_files`, `mcp__github__merge_pull_request`, `mcp__claude_ai_Gmail__send_message`, `mcp__slack__slack_post_message`, `mcp__stripe__create_refund`.

It also holds repository writes on a git host's server (`create_or_update_file`, `create_branch`, `delete_file`) and **changes other people see**: calendar events created, updated, moved, cancelled or answered (invites go out: `mcp__Google_Calendar__create_event`), pages, docs, files, blocks and database rows created or updated on a docs server (Notion, Confluence, Google Docs/Drive/Sheets, SharePoint, Dropbox, Airtable, Coda: `mcp__notion__notion-update-page`), new permissions or collaborators (`create_permission`), and comments (`add_issue_comment`). Moving pages on a docs server is held too (`notion-move-pages`). **Local filesystem MCP servers** (a server named like `filesystem`, `fs`, `desktop-commander`, `local-files`): a write tool (`write_file`, `edit_file`, `move_file`, `create_directory`, …) whose path is outside the project and outside the temp folders is held (`/etc/hosts`, `~/.zshrc`, `../other-project`), symlinks resolved: Claude Code asks before its own `Write` outside the project, not before an MCP server's. Their protected paths and secret files are held by `flowrail-tamper` and `secret-files`, and `protect-path` holds their writes like `Write`. Drafts (`create_draft`, `update_draft`) are fine, and so is creating an issue in a tracker (a documented gap: write a rule with the tool's name if you want it asked).

### `email-send`

Used by `no-emails-without-signoff` (`"tool": "*"`, severity `block` by default; set `ask` if you prefer). Holds the mail CLIs (`sendmail`, `mail`, `mailx`, `mutt`, `neomutt`, `msmtp`, `swaks`), `aws ses send-*`, `curl`/`wget`/`http` to a send endpoint (SendGrid `/v3/mail/send`, Postmark `/email`, Resend `/emails`, Mailgun `/messages`, SES, Brevo), and MCP tools that send, forward or reply on a mail server (`mcp__gmail__send_email`, `mcp__claude_ai_Gmail__reply`, `mcp__outlook__sendMail`, a `send_email` tool on any server), at the line's severity. Drafts (`create_draft`), searches and reads are fine, and so is `send_message` on a chat server (that is `mcp-actions`).

### `payments`

Used by `no-payments` (severity `block`). Holds MCP tools that move money on a payment server (a server named like `stripe`, `paypal`, `braintree`, `adyen`, `mollie`, `paddle`, `square`, …): tools with charge, refund, payout, transfer, pay or capture in their name; finalize, send, pay, void, cancel, update, delete, pause, resume or apply (and close, accept, archive, deactivate) on payments, invoices, subscriptions, payment intents, orders, credits, coupons, discounts, prices, plans, disputes, promotion codes, products or balances (`finalize_invoice` emails the invoice, `update_subscription` changes what a customer pays, `update_dispute` submits evidence); and creating charges, refunds, payouts, transfers, payments, intents, subscriptions, orders, or billing changes: coupons, discounts, promotion codes, prices, plans, payment links. Billing changes (a coupon, a price, a plan, a promotion code, a payment link, a product update, a dispute answer) change what customers pay later and are held as `ask` even on a `block` line; moving money is held at the line's severity. Also the Stripe CLI (`stripe refunds create`, `stripe payouts create`, …) and `curl` POSTs to `api.stripe.com/v1/charges|refunds|payouts|transfers|payment_intents`. Listing, searching and retrieving are fine, and so are `create_customer`, `create_product` and `create_invoice` (a record, or a draft until it is finalized or sent).

### `infra-destructive`

Used by the recipe `infra-destructive` (severity `ask`), which `flowrail init` offers when the project uses kubectl, terraform, aws, gcloud, helm or pulumi. Holds `kubectl delete` and `kubectl drain` (options like `--context prod` before the verb included), `terraform destroy`, `terraform apply -auto-approve` (and `-destroy`), `terraform state rm|push` (also `tofu`), `aws s3 rm --recursive`, `aws s3 rb --force`, `aws s3 sync --delete`, any `aws <service> delete-*|terminate-*|remove-*|deregister-*|purge-*`, `gcloud`/`az`/`doctl … delete`, `gsutil rm -r`, `helm uninstall`, `pulumi destroy`, `fly apps destroy`, `heroku apps:destroy|pg:reset`, `docker volume rm|prune` and `docker system prune`. A plain `terraform apply` (which asks for confirmation itself) and every read are fine; `publish-deploy` holds `terraform apply` and `kubectl apply` as deploys.

### `db-destructive`

Used by the recipe `db-destructive` (severity `ask`), offered when the project talks to a database (`psql`, `mysql`, `DATABASE_URL`, Prisma, `db/migrate`). Holds SQL that destroys data sent to `psql`, `mysql`, `mariadb`, `sqlite3`, `mongosh`, `redis-cli`, `duckdb` and friends, in `-c`/`-e` arguments, heredocs or `echo … |` pipes: `DROP TABLE|DATABASE|SCHEMA|COLLECTION`, `TRUNCATE`, `DELETE FROM x` without `WHERE`, `db.dropDatabase()`, `FLUSHALL`/`FLUSHDB`. Also `prisma migrate reset`, `prisma db push --force-reset|--accept-data-loss`, `rails db:drop|reset|schema:load|purge`, `dropdb` and Django's `manage.py flush`. `SELECT`, `DELETE … WHERE`, migrations and `grep "DROP TABLE"` are fine.

### `publish-deploy`

Holds publishing, releasing, merging and deploying from the shell: `npm`/`pnpm`/`yarn`/`bun publish` and `run deploy|release|publish|ship…`, `make`/`just`/`task deploy|release|publish|ship…`, `gh pr merge`, `gh release create|delete|upload|edit`, `gh repo delete|archive|rename|edit`, `gh workflow run`, a merge through the GitHub REST API (`gh api -X PUT …/pulls/<n>/merge` or with `-f` fields, `curl -X PUT|POST …/repos/<o>/<r>/pulls/<n>/merge` or `…/merges`), `yarn npm publish`, `cargo publish`, `twine upload`, `gem push`, `poetry publish`, `docker push`, `vercel --prod` (and `promote`, `rollback`), `netlify deploy --prod`, `fly deploy`, `wrangler deploy`, `firebase deploy`, `kubectl apply|rollout|delete|replace|scale`, `terraform apply|destroy`, `helm install|upgrade|uninstall|rollback`, `serverless`/`cdk`/`eas`/`railway`/`amplify deploy`, `pulumi up|destroy`, and `gcloud`/`aws`/`az … deploy`. The recipes `no-deploy-without-asking`, `no-publish-without-asking` and `publish-deploy` (offered by `flowrail init` when the repo shows `gh pr merge`/`gh release create` in its scripts or CI, vercel, fly, a Dockerfile, a deploy step in `.github/workflows`, a deploy script or a package.json with `publishConfig` or `"private": false`) use it; init writes one line for the builtin, however many rules name it.

### `protect-path`

Holds deleting, moving or overwriting files under a glob you choose: `"hook": { "tool": "*", "builtin": "protect-path", "params": { "glob": "content/**" } }`. It holds `rm` (any target under the glob, or a folder that contains it, `rm -rf .` included), `unlink`, `shred`, `truncate`, `mv` out of it, `cp`/`mv`/`rsync`/`install` over an existing file in it, a `>` redirect over an existing file in it, `rsync --delete` into it, `git rm`/`git mv`, `git clean -f` over it, `find … -delete`, and MCP delete and move tools with a `path` in it, and a `Write` that replaces an existing file under the glob. Writing new files, `Edit` (changing part of a file), appending, reading and copying out are fine. `find … -delete` is held when it starts in the folder, when its `-path` names it, or when it starts above it and its `-name` can match a file that is in the folder now (`find . -name "*.log" -delete` is fine if `content/` has no `.log` files; with no `-name` at all it is held). `flowrail init` offers it for rules like "Don't delete anything in content/", and `flowrail redlines add protect-path --glob "content/**"` adds one by hand.

With `"edits": true` (what `flowrail init` writes for "Don't touch config/prod.yaml", "Never modify infra/"), changing a file in place is held too: `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, MCP write tools, `>` and `>>`, `tee` and `tee -a`, `sed -i`, `perl -pi`, `ruby -i`, `truncate`, `dd of=`, and `cp` or `mv` onto it. Reading and copying out are still fine.

Paths are compared with symlinks resolved, for the project too: a link into the folder is the folder (`ln -s content c2; rm -rf c2/`, in one command or two), and a project reached through a symlink (macOS `/var/folders` is `/private/var/folders`) is held the same whichever spelling the hook, `redlines test` or `redlines verify` is given. `rm link` without a trailing slash removes only the link and is fine.

### `command`

One command a rule quotes, matched on its argv instead of a prefix regex: `"hook": { "tool": "Bash", "builtin": "command", "params": { "argv": ["git", "commit"], "flags": ["--no-verify"] } }`. The program must match, the subcommand words must follow in order (a global option or two may sit in front), and every flag must be there, in any order, long or short, bundled or not: `git commit -m fix --no-verify`, `git commit -nm fix`, `git commit --no-verif`, `sudo git commit --no-verify` and `bash -c 'git commit -n -m x'` are all held; `git commit -m "--no-verify is banned"` is not. Short forms come from a small table (`--force`/`-f`, `--recursive`/`-r`, `--all`/`-a`, `--yes`/`-y`, and per command, like `git commit --no-verify`/`-n`); a flag without one matches in its long form. `flowrail init` writes this for a command a rule quotes (`` Never use `git commit --no-verify` ``), and `flowrail redlines verify` probes it with variants (flags reordered, the short form bundled, `sudo` in front) so it is never called covered unless they hold. A quoted command with shell syntax in it (`|`, `$`, quotes) falls back to a prefix regex.

### `file-field`

For a rule that depends on a record rather than on the command: hold a script when the file it is pointed at says so in its frontmatter.

```json
{
  "id": "no-cold-outreach-de-at",
  "title": "No first contact to leads in Germany or Austria",
  "severity": "block",
  "hook": { "tool": "Bash", "builtin": "file-field", "params": {
    "scripts": ["scripts/send-email.ts"], "commands": [["npm", "run", "send-email"]],
    "flag": "--lead", "field": "region", "values": ["germany", "austria"],
    "except": { "status": ["responded"] }
  } }
}
```

A command matches when it runs one of `scripts`, as the program itself or as the first word after a runner (`npx tsx scripts/send-email.ts`, `node ./scripts/send-email.ts`, an absolute path; `cat scripts/send-email.ts` does not run it), or when it runs one of `commands` (matched like the `command` builtin). The guard then reads the first 64 KB of every file given to `flag` (`--lead a.md` or `--lead=a.md`), inside the project and not a secret file, and blocks when the frontmatter line `field:` starts with one of `values` (case-insensitive, quotes ignored). A file whose frontmatter matches `except` is let through. When no file is named, the value is a variable, or the file cannot be read, it holds at `missing` (default `ask`), since it cannot tell.

## What the hook tests

The subject depends on the tool:

| Tool | Subject |
|---|---|
| `Bash` | `tool_input.command`, parsed into simple commands (see below) |
| `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Read`, `Grep` | `tool_input.file_path` (or `notebook_path`, or Grep's `path`) |
| anything else, including MCP tools | `JSON.stringify(tool_input)` for `match` lines; the builtins read MCP inputs themselves (`path`, `source`, `destination`, `content`, ...) |

File paths usually arrive absolute (`/home/you/project/.env`). Anchor path regexes with `(^|/)` rather than `^`.

For MCP tools the subject is the whole input as JSON, so a rule like `{"tool": "mcp__mail__send", "match": "."}` holds every call to that tool. `hook.tool` takes `*` wildcards, so `"mcp__github__*"` covers one server.

## The shell parser

An agent rarely types the textbook form of a command. It adds a `cd`, a path, an environment variable, a wrapper shell, a backslash. Before matching, flowrail splits a Bash command into simple commands, each an argv plus its redirects. It:

1. splits on `;`, `&&`, `||`, `|`, `&`, newlines, `(` and `)` outside quotes;
2. undoes quoting and escapes the way the shell does: `\git pu\sh`, `g''it`, `"git" "push"`, `$'\x67it'` all become `git push`;
3. strips leading environment assignments and the wrappers `sudo`, `doas`, `command`, `builtin`, `exec`, `env`, `nohup`, `time`, `nice`, `ionice`, `timeout`, `stdbuf`, `xargs`, `watch`, `unbuffer`, `caffeinate`, `chronic`, `xcrun`, `arch` (`arch -arm64 git push`) and `script` (`script -q /dev/null git push`, `script -c 'git push'`), and a path on the program (`/usr/bin/git` becomes `git`, `$(which git)` becomes `git`);
4. unwraps `sh -c`, `bash -lc`, `zsh -c`, `su -c`, `eval`, the command after `find -exec`, command substitutions (`$(…)`, backquotes, `<(…)`), and scripts fed to a shell (`bash <<EOF`, `cat <<EOF | sh`, `echo 'git push' | bash`, `bash <<< '…'`, and what `echo`/`printf` print into `bash <(…)` or `source <(…)`);
5. for `git`, drops global options before the subcommand (`-C <dir>`, `-c <key=value>`, `--git-dir=…`, `--work-tree=…`, `--no-pager`) and expands `-c alias.x=…` aliases; the matchers read long options by prefix (`--har` is `--hard`);
6. for `python -c`, `node -e`, `perl -e`, `ruby -e` and friends, also checks every string literal in the script, every list of literals joined (`['git', 'push']`) and Perl's `q(…)`/`qq{…}` strings, as a command; the same for an `awk` program (`awk 'BEGIN{system("git push")}'`);
7. splits a word on `$IFS` / `${IFS}` the way the shell does, so `git${IFS}push` is `git push`;
8. treats a heredoc body as data unless it is fed to a shell, so `git commit -F- <<EOF` with "never git push" in the message is not a push.

`hook.match` regexes run against each simple command rendered as a string: `git push origin main`, with redirects at the end (`echo hi > out.txt`). Write them against that form: `^git push\b`, not `git\s+push`. Set `"raw": true` when you really do want the unprocessed string, for example to hold any command that mentions a production hostname anywhere.

Try a command without running it (a dry run: nothing is logged):

```sh
npx flowrail redlines test "bash -lc 'git -C ~/src/app push --force'"
```

The output names the decision, the red line, what was held and the parsed commands.

## What a red line does not hold

The hook sees the command Claude hands to the tool, not what that command eventually does. Each of these is a `GAP` line in the corpus, so this list and the tests agree:

- **Indirection through a file.** `./release.sh`, `make push`, `npm run ship` or `python3 release.py` that pushes internally. The hook sees the script's name. (A script that names the guard's files or the dashboard's port is held when it is written and when it runs; see `flowrail-tamper`.)
- **Encoding.** `echo Z2l0IHB1c2g= | base64 -d | sh`.
- **Other interpreters' own APIs.** A script that deletes the home folder or `/` by name is held (`rm-dangerous`), but one whose target is computed (`ruby -e 'd = ENV.fetch("H"); FileUtils.rm_rf(d)'`) is not, and `python3 -c "import shutil; shutil.rmtree('content')"` gets past `protect-path`.
- **Merges through GraphQL.** `gh api graphql -f query='mutation { mergePullRequest(…) }'` is not recognized as a merge.
- **Other tools.** A CLI you did not write a rule for, or an MCP tool whose name says nothing about what it does (`mcp__custom__run`, `execute_sql`), can have the same effect as the command you did write a rule for. `docker compose config` prints environment files.
- **Content changed in place.** Without `"edits": true`, `protect-path` holds deletes, moves, overwrites from the shell and a `Write` over an existing file; an `Edit` that empties a file piece by piece is an edit, and is not held.
- **Writers that do not name a protected file.** `git stash pop`, a merge, or a compiled program can still rewrite `red-lines.json`. Drift detection notices it on the next call and asks until you run `flowrail redlines accept`; the write itself happened.
- **A hard link made outside the agent.** `ln flowrail/red-lines.json x` is held, but a hard link that already exists is a separate name for the same file and is not recognized.

The full table of ways to switch the guard off, and which are held, is [tamper-model.md](tamper-model.md).

Patches that close a gap with a failing `HOLD` line are welcome. Most of these cannot be closed by pattern matching at all. For anything where a mistake is expensive, add a second layer that does not depend on the agent's cooperation: branch protection on the remote, credentials the agent's environment does not have, a production database that rejects connections from your laptop.

## Recipes

Each recipe ships as a file in `packages/flowrail/examples/red-lines/` and as a built-in recipe. List them with `flowrail redlines add --list`, add one with `flowrail redlines add <id>`, or copy the entry into `flowrail/red-lines.json` and adjust it. The first six are the starter red lines that `flowrail init` writes.

**Never push without asking.** Starter.

```json
{
  "id": "no-push-without-asking",
  "title": "Never push without asking",
  "why": "Pushing publishes work. A human decides when.",
  "severity": "ask",
  "hook": {
    "tool": "Bash|mcp__*",
    "builtin": "git-push"
  }
}
```

**No destructive git commands.** Starter.

```json
{
  "id": "no-destructive-git",
  "title": "No destructive git commands",
  "why": "Force pushes, hard resets, forced cleans and branch deletes lose work that may not exist anywhere else.",
  "severity": "block",
  "hook": {
    "tool": "Bash",
    "builtin": "git-destructive"
  }
}
```

**Keep secrets out of the repo and out of the chat.** Starter.

```json
{
  "id": "no-secrets-in-repo",
  "title": "Keep secrets out of the repo and out of the chat",
  "why": "Committed secrets leak through history even after they are deleted, and a secret read into the session is a secret shared.",
  "severity": "block",
  "hook": {
    "tool": "*",
    "builtin": "secret-files"
  },
  "check": {
    "glob": "**/*",
    "pattern": "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    "message": "Private key committed to the repo"
  }
}
```

A hook and a check: the builtin holds writes to secret files and asks before reads (see [secret-files](#secret-files)); the check catches a private key that arrived some other way.

**No recursive deletes outside the project.** Starter.

```json
{
  "id": "no-rm-rf-outside-project",
  "title": "No recursive deletes outside the project",
  "why": "One typo away from an empty disk.",
  "severity": "block",
  "hook": {
    "tool": "Bash",
    "builtin": "rm-dangerous"
  }
}
```

**Ask before changing the guardrails.** Starter, and built into the guard as the floor.

```json
{
  "id": "protect-flowrail",
  "title": "Ask before changing the guardrails",
  "why": "Red lines, flowrail settings and the Claude Code hooks are the human's to change. An agent that edits them has switched off its own seatbelt.",
  "severity": "ask",
  "hook": {
    "tool": "*",
    "builtin": "flowrail-tamper"
  }
}
```

**Ask before MCP tools send, publish, merge or delete.** Starter.

```json
{
  "id": "ask-before-mcp-actions",
  "title": "Ask before MCP tools send, publish, merge or delete",
  "why": "An MCP tool that sends an email, merges a pull request or deletes a record acts in the world. A human says yes first.",
  "severity": "ask",
  "hook": {
    "tool": "mcp__*",
    "builtin": "mcp-actions"
  }
}
```

**Ask before deploying.**

```json
{
  "id": "no-deploy-without-asking",
  "title": "Ask before deploying",
  "why": "Deploys change what users see. A human presses the button.",
  "severity": "ask",
  "hook": {
    "tool": "Bash",
    "builtin": "publish-deploy"
  }
}
```

**Ask before publishing a package or release.**

```json
{
  "id": "no-publish-without-asking",
  "title": "Ask before publishing a package or release",
  "why": "A published version cannot be taken back.",
  "severity": "ask",
  "hook": {
    "tool": "Bash",
    "builtin": "publish-deploy"
  }
}
```

Both use the `publish-deploy` builtin, so either one holds deploys and publishes alike.

**Never send email without sign-off.**

```json
{
  "id": "no-emails-without-signoff",
  "title": "Never send email without sign-off",
  "why": "Email cannot be unsent. Drafts are fine; sending needs a human.",
  "severity": "block",
  "hook": {
    "tool": "*",
    "builtin": "email-send"
  }
}
```

It holds the common mail CLIs, send calls to mail APIs, and send, forward and reply tools on mail MCP servers, at the line's severity (see [`email-send`](#email-send)). Drafts are fine. `flowrail init` offers it when it finds a mail MCP server.

**Never move money without a human.**

```json
{
  "id": "no-payments",
  "title": "Never move money without a human",
  "why": "Charges, refunds and payouts reach real people's accounts.",
  "severity": "block",
  "hook": { "tool": "*", "builtin": "payments" }
}
```

Offered by `flowrail init` when it finds a payment MCP server (Stripe, PayPal, …). See [`payments`](#payments).

**Ask before destroying infrastructure** (`infra-destructive`), **Ask before destroying data** (`db-destructive`) and **Ask before publishing, merging or deploying** (`publish-deploy`) are the project-aware starters: `flowrail init` offers each one when the repo shows the tooling (package.json, Makefile, CI workflows, `.env.example`, `*.tf`, `k8s/`, `helm/`, a `Dockerfile`, `fly.toml`, `prisma/schema.prisma`, …; a program on your `PATH` is not evidence), and says what it found:

```text
Starters for what this project uses
  Found terraform (infra/main.tf), kubectl (package.json). Add infra-destructive (ask): Asks before destroying infrastructure: ...? [Y/n]
```

**Never drop tables or databases.**

```json
{
  "id": "no-drop-table",
  "title": "Never drop tables or databases",
  "why": "Dropped data is gone unless a backup is fresh and tested.",
  "severity": "block",
  "hook": {
    "tool": "Bash",
    "match": "\\bdrop\\s+(table|database|schema)\\b",
    "flags": "i",
    "raw": true
  }
}
```

**Ask before touching the production database.**

```json
{
  "id": "no-prod-db",
  "title": "Ask before touching the production database",
  "why": "Production data belongs to users.",
  "severity": "ask",
  "hook": {
    "tool": "Bash",
    "match": "^(psql|mysql|mongosh|mongo|redis-cli|pg_dump|pg_restore)\\b.*(prod|production)",
    "flags": "i"
  }
}
```

`flags: "i"` makes the match case-insensitive, so `PROD` and `Production` count too. It only sees database clients called directly; a script that connects on its own gets past it (see above).

**Ask before editing existing migrations.**

```json
{
  "id": "protect-migrations",
  "title": "Ask before editing existing migrations",
  "why": "Migrations that already ran elsewhere must not change. Write a new one.",
  "severity": "ask",
  "hook": {
    "tool": "Write|Edit|MultiEdit",
    "match": "(^|/)(migrations?|db/migrate)/"
  }
}
```

This asks on every migration edit, new ones included, because a path alone cannot tell shipped from unshipped. Most people find one confirmation per new migration acceptable.

**Ask before deleting, moving or overwriting files in a folder.**

```json
{
  "id": "protect-path",
  "title": "Ask before deleting, moving or overwriting files in content/",
  "why": "These files are the product. Deleting or replacing them is a human decision.",
  "severity": "ask",
  "hook": {
    "tool": "*",
    "builtin": "protect-path",
    "params": {
      "glob": "content/**"
    }
  }
}
```

Change the glob and the id for your folder, or let `flowrail init` write it from a rule like "Don't delete anything in content/".

**Use pnpm, not npm or yarn.**

```json
{
  "id": "prefer-pnpm",
  "title": "Use pnpm, not npm or yarn",
  "why": "This project uses pnpm. npm or yarn would write a second lockfile.",
  "severity": "ask",
  "hook": {
    "tool": "Bash",
    "match": "^(npm (install|i|ci|add|update|uninstall|remove)\\b|yarn(\\s|$))"
  }
}
```

## Writing checks

A check scans files that match `glob` and reports every line where `pattern` matches.

- Globs are relative to the repo root. `**` crosses directories; `*` does not.
- `.git/`, `node_modules/` and `.flowrail/` are never scanned, and neither are binary files.
- The pattern is applied per line, so `^` and `$` mean the start and end of a line.
- Keep patterns specific. A check that fires on every commit is a check someone deletes.

Checks and hooks cover different moments. A hook stops Claude from writing the `.env` file; a check catches the private key that arrived in a file from somewhere else, such as a pasted log or a merged pull request.

## In CI

`flowrail check` exits 1 when any `block` severity check has a hit, and 0 otherwise. `ask` and `warn` hits are printed but do not fail the run.

```yaml
# .github/workflows/red-lines.yml
name: Red lines
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx flowrail check
```

Hooks do not run in CI; only checks do. If a rule matters both on your machine and in review, give it both.

## The log

Every hook decision is appended to `.flowrail/redlines.log`, one JSON object per line:

```json
{"at":"2026-01-12T14:02:11.408Z","id":"no-destructive-git","severity":"block","decision":"deny","tool":"Bash","subject":"git push --force origin main","what":"force push"}
{"at":"2026-01-12T14:05:40.001Z","id":"no-secrets-in-repo","severity":"block","decision":"deny","tool":"Write","subject":"config/.env","path":"config/.env","what":"writing .env"}
```

- `subject` is redacted (URL credentials, `token=`/`key=`/`password=` values, `Authorization` and `Bearer` values, known token shapes and long hex or base64 runs become `***`), shown relative to the project, and truncated to 200 characters. File tools also get `path`.
- A hook call without a Claude Code `session_id` (you piping JSON into `flowrail hook` to try it) is logged with `"probe": true` and does not count as a hold. `flowrail redlines test` and the dashboard's tester write nothing.
- A change to the red lines saved through the dashboard (or `flowrail redlines add`) is logged as `{"decision":"changed","by":"dashboard","added":[…],"removed":[…],"changed":[…]}` and shown on the dashboard.
- Every entry is also appended to a hash-chained journal outside the repo, so an edited or trimmed log shows up in `flowrail doctor` and the dashboard as "Audit log edited" (see [security.md](security.md#the-audit-trail)).

The dashboard counts `block` and `ask` holds from the last seven days (for example "Held 4× this week"); `warn` entries and probes are logged but not counted. The log is per machine and gitignored.
