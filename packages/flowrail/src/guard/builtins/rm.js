// rm-dangerous: recursive deletes of /, home, everything or anything outside the project, moving
// home away, and wiping disks. Part of the vendored guard.
import os from 'node:os';
import path from 'node:path';
import {
  hold, has, shortFlags, positionals, resolveWord, realish, inside, toPosix, GLOB_ALL, eachCommand,
  EXEC_FLAGS, inlineCode,
} from './common.js';

const TMP_ROOTS = [...new Set(['/tmp', '/private/tmp', '/var/tmp', '/var/folders',
  '/private/var/folders', toPosix(os.tmpdir())])];
const BARE = ['*', '.*', '.', '..', '/', '/*', '~', '~/*', './*', '$HOME', '${HOME}', '$HOME/*',
  '${HOME}/*'];
const DISK = /^\/dev\/(r?disk\d|sd[a-z]|hd[a-z]|nvme\d|xvd[a-z]|vd[a-z]|mmcblk\d)/;

/**
 * Is `x` a place a recursive delete may touch: inside the project, or inside a temp folder that
 * is not the project itself or one of its parents (a project under /tmp keeps /tmp/a safe).
 */
function deletable(x, r, rReal) {
  if (inside(x, r) || inside(x, rReal)) return true;
  if (inside(r, x) || inside(rReal, x)) return false;
  return TMP_ROOTS.some((t) => x !== t && inside(x, t));
}

/** Why deleting `word` recursively is dangerous, or null when fine. 'unknown' for variables. */
function dangerousTarget(word, cwd, root, { find = false, links = {} } = {}) {
  const w = word.replace(/\/+$/, '') || '/';
  if (!find && (BARE.includes(w) || GLOB_ALL.test(w))) return w;
  let abs = resolveWord(w, cwd);
  if (!abs) return 'unknown';
  // "dir/*" deletes what is in dir: judge dir.
  const globbed = GLOB_ALL.test(path.posix.basename(abs));
  if (globbed) abs = path.posix.dirname(abs);
  // Symlinks: `rm -rf link/` and `rm -rf link/*` delete what the link points at; a link made
  // earlier in the same command line (ln -s ~ /tmp/h && rm -rf /tmp/h/) counts too.
  const follow = globbed || /\/$/.test(word);
  const made = links[abs];
  const real = made ? realish(made) : follow ? realish(abs)
    : path.posix.join(realish(path.posix.dirname(abs)), path.posix.basename(abs));
  const r = toPosix(root);
  const rReal = realish(r);
  const home = toPosix(os.homedir());
  for (const x of new Set([abs, real])) {
    if (x === '/' || x === home || x === realish(home)) return x;
    if ((x === r || x === rReal) && !find) return x;
  }
  const rel = path.posix.relative(r, abs) || '';
  if (!find && /(^|\/)\.git(\/|$)/.test(rel)) return `${rel} (the git history)`;
  if (deletable(abs, r, rReal) && deletable(real, r, rReal)) return null;
  return deletable(abs, r, rReal) ? real : abs;
}

/** mv of /, home or the project, or anything into /dev/null. */
function moveAway(argv, cwd, root) {
  const pos = positionals(argv.slice(1));
  if (pos.length < 2) return null;
  const dest = pos[pos.length - 1];
  if (dest === '/dev/null') return hold('block', `mv ${pos[0]} /dev/null`);
  const home = toPosix(os.homedir());
  for (const s of pos.slice(0, -1)) {
    const abs = resolveWord(s.replace(/\/+$/, '') || '/', cwd);
    if (abs === '/' || abs === home || abs === toPosix(root)) return hold('block', `mv ${s}`);
  }
  return null;
}

/** dd onto a disk, mkfs, diskutil erase, wipefs: the whole disk is gone. */
function diskWipe(argv, redirects) {
  const [bin, sub] = argv;
  for (const r of redirects) if (DISK.test(r.target) && r.op !== '<') return `writing ${r.target}`;
  if (bin === 'dd') {
    const of = argv.find((a) => a.startsWith('of='));
    if (of && DISK.test(of.slice(3))) return `dd ${of}`;
  }
  if (/^(mkfs|newfs)(\.|_|$)/.test(bin || '') || bin === 'wipefs') return bin;
  const erase = /^(erase|zero|random|secureErase|partitionDisk|reformat)/i;
  if (bin === 'diskutil' && erase.test(sub || '')) {
    return `diskutil ${sub}`;
  }
  if (bin === 'sgdisk' && has(argv, '--zap-all', '-Z')) return bin;
  if (bin === 'shred' && argv.some((a) => DISK.test(a))) return bin;
  return null;
}

function findDelete(argv, cwd, ctx, links) {
  const deletes = argv.includes('-delete') || argv.some((a, i) => EXEC_FLAGS.includes(a)
    && ['rm', 'shred', 'unlink'].includes(path.posix.basename(argv[i + 1] || '')));
  if (!deletes) return null;
  const roots = [];
  let k = 1;
  for (; k < argv.length; k++) {
    const a = argv[k];
    if (a.startsWith('-') || a === '(' || a === '!') break;
    roots.push(a);
  }
  // find is filtered by design (find . -name '*.pyc' -delete), so only where it starts counts,
  // unless nothing filters it: a bare `find . -delete` empties the folder.
  const NO_FILTER = new Set(['-delete', '-depth', '-xdev', '-mount', '-mindepth', '-maxdepth',
    '-print', '-L', '-H', '-P']);
  const expr = [];
  for (let j = k; j < argv.length; j++) {
    if (EXEC_FLAGS.includes(argv[j])) {
      while (j < argv.length && argv[j] !== ';' && argv[j] !== '+') j++;
      continue;
    }
    expr.push(argv[j]);
  }
  const filtered = expr.some((a) => a.startsWith('-') && !NO_FILTER.has(a));
  const found = (roots.length ? roots : ['.'])
    .map((t) => dangerousTarget(t, cwd, ctx.root, { find: filtered, links })).filter(Boolean);
  if (found.some((f) => f !== 'unknown')) {
    return hold('block', `find ${found.find((f) => f !== 'unknown')} -delete`);
  }
  if (found.length) return hold('ask', 'find -delete on a path set by a variable');
  return null;
}

// Node packages that are rm -rf: npx rimraf ~, npx del-cli ~, trash ~.
const DELETERS = new Set(['rimraf', 'del-cli', 'del', 'trash', 'trash-cli', 'rm-cli', 'premove']);
const NPX = new Set(['npx', 'bunx', 'pnpx']);
const RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);

/** The targets of a node deleter (npx rimraf ~, pnpm dlx del-cli x, rimraf x), or null. */
function nodeDeleter(argv) {
  let rest = argv;
  if (NPX.has(argv[0])) rest = argv.slice(1);
  else if (RUNNERS.has(argv[0]) && ['exec', 'x', 'dlx'].includes(argv[1])) rest = argv.slice(2);
  let i = 0;
  while (rest !== argv && i < rest.length && rest[i].startsWith('-')) {
    i += ['-p', '--package'].includes(rest[i]) ? 2 : 1;
  }
  const name = String(rest[i] || '').replace(/(.)@[^/]*$/, '$1');
  return DELETERS.has(path.posix.basename(name)) ? positionals(rest.slice(i + 1)) : null;
}

// ruby -e 'FileUtils.rm_rf(Dir.home)', node -e 'fs.rmSync(os.homedir(), ...)', python -c
// 'shutil.rmtree(os.path.expanduser("~"))': a script that deletes the home folder or / by name.
const SCRIPT_DELETE = new RegExp('rm_rf|rm_r\\b|rmtree|rmSync|rmdirSync|remove_tree|FileUtils\\.rm'
  + '|fs\\.rm\\b|File::Path|rimraf|remove_entry_secure');
const SCRIPT_HOME = new RegExp('Dir\\.home|homedir\\(\\)|expanduser\\(\\s*[\'"]~/?[\'"]'
  + '|Path\\.home\\(\\)|\\$ENV\\{\\s*[\'"]?HOME|ENV\\[\\s*[\'"]HOME|process\\.env\\.HOME'
  + '|environ\\[\\s*[\'"]HOME|getenv\\(\\s*[\'"]HOME|[\'"]~/?[\'"]|[\'"]/[\'"]');
const CONTAINER_DELETE = /(^|[\s;&|])(rm|shred|dd|mkfs\S*|find|wipefs)(\s|$)/;

/** The host side of docker -v/--volume/--mount values. */
function mountSources(argv) {
  const mounts = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-v' || a === '--volume' || a === '--mount') mounts.push(String(argv[++i] || ''));
    else if (/^(--volume|--mount)=/.test(a)) mounts.push(a.slice(a.indexOf('=') + 1));
    else if (/^-v./.test(a)) mounts.push(a.slice(2));
  }
  return mounts.map((m) => {
    const src = /(?:^|,)(?:source|src)=([^,]*)/.exec(m);
    return src ? src[1] : m.split(':')[0];
  });
}

/** docker run -v ~:/h alpine rm -rf /h: the container deletes what the host mounted. */
function containerDelete(argv, cwd) {
  const [bin, sub, sub2] = argv;
  if (!['docker', 'podman', 'nerdctl'].includes(bin)) return null;
  if (!(sub === 'run' || (sub === 'container' && sub2 === 'run'))) return null;
  const home = toPosix(os.homedir());
  const wide = mountSources(argv).some((h) => {
    const abs = resolveWord(h.replace(/\/+$/, '') || '/', cwd);
    return abs === '/' || abs === home || (abs && realish(abs) === realish(home));
  });
  const destroys = argv.slice(2).some((w) => CONTAINER_DELETE.test(w));
  return wide && destroys ? 'a container with your home folder or / mounted, running a delete'
    : null;
}

export function rmDangerous(ctx) {
  if (ctx.tool !== 'Bash') return null;
  const links = {};
  return eachCommand(ctx, ({ argv, redirects }, cwd) => {
    const wipe = diskWipe(argv, redirects);
    if (wipe) return hold('block', wipe);
    const [bin] = argv;
    if (bin === 'ln' && /s/.test(shortFlags(argv.slice(1)))) {
      const pos = positionals(argv.slice(1));
      const target = pos.length >= 2 && resolveWord(pos[0], cwd);
      const link = pos.length >= 2 && resolveWord(pos[pos.length - 1], cwd);
      if (target && link) links[link] = target;
      return null;
    }
    if (bin === 'mv') return moveAway(argv, cwd, ctx.root);
    // eval "$(printf 'rm -rf ~')": the command is only known when it runs.
    if (/^(\$\(.*\)|`.*`)$/s.test(bin || '')) {
      return hold('ask', 'a command made by a command substitution (eval "$(...)")');
    }
    const container = containerDelete(argv, cwd);
    if (container) return hold('ask', container);
    const code = inlineCode(argv);
    if (code !== null && SCRIPT_DELETE.test(code) && SCRIPT_HOME.test(code)) {
      return hold('block', `a ${bin} script deleting your home folder or /`);
    }
    const deleter = nodeDeleter(argv);
    if (bin === 'rm' || deleter) {
      const end = argv.indexOf('--');
      const opts = argv.slice(1, end === -1 ? undefined : end).filter((a) => a.startsWith('-'));
      const recursive = deleter || has(opts, '--recursive') || /r/i.test(shortFlags(opts));
      if (!recursive) return null;
      const targets = deleter || positionals(argv.slice(1));
      if (!targets.length) return hold('ask', 'rm -r with targets from a pipe');
      const found = targets.map((t) => dangerousTarget(t, cwd, ctx.root, { links }))
        .filter(Boolean);
      const known = found.find((f) => f !== 'unknown');
      if (known) return hold('block', `rm -r ${known}`);
      if (found.length) return hold('ask', 'rm -r on a path set by a variable');
      return null;
    }
    if (bin === 'rsync' && argv.some((a) => /^--delete/.test(a) || a === '--remove-source-files')) {
      const pos = positionals(argv.slice(1));
      const dest = pos[pos.length - 1];
      const remote = dest && /^[\w.-]+@?[\w.-]*:/.test(dest);
      const bad = dest && !remote && dangerousTarget(dest, cwd, ctx.root, { find: true, links });
      if (bad && bad !== 'unknown') return hold('block', `rsync --delete into ${bad}`);
    }
    if (bin === 'find') return findDelete(argv, cwd, ctx, links);
    return null;
  });
}
