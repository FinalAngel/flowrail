// protect-path: deleting, moving or overwriting files under a folder the project cares about.
// Part of the vendored guard.
import fs from 'node:fs';
import path from 'node:path';
import {
  hold, shortFlags, positionals, resolveWord, toPosix, eachCommand, inputPaths, mcpName, words,
  mcpWrites, nameGlob, globToRegex, realPath, realish, trackLink, EXEC_FLAGS, WRITE_OPS,
  FILE_WRITE_TOOLS,
} from './common.js';

/**
 * A matcher for one protect-path glob: covers(rel) is true when deleting `rel` removes something
 * the glob covers (the path itself, or a folder above it); within(rel) only for paths inside.
 */
function pathGlob(glob) {
  const g = String(glob).replace(/^\.\//, '').replace(/\/$/, '/**');
  const re = globToRegex(g);
  const parts = g.split('/');
  const cut = parts.findIndex((s) => /[*?{[]/.test(s));
  const prefix = (cut === -1 ? parts : parts.slice(0, cut)).join('/');
  const outside = (rel) => rel === '..' || rel.startsWith('../');
  const within = (rel) => !outside(rel) && (re.test(rel) || re.test(rel + '/x'));
  const covers = (rel) => !outside(rel)
    && (within(rel) || rel === '' || prefix === rel || prefix.startsWith(rel + '/'));
  return { covers, within, prefix };
}

/** Files under `dir` (bounded), relative to it, for "can this find expression reach them". */
function listFiles(dir, limit = 5000) {
  const out = [];
  const stack = [''];
  while (stack.length && out.length < limit) {
    const rel = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else out.push(r);
    }
  }
  return out;
}

/**
 * find ... -delete (or -exec rm) starting above the protected folder: held only when its name or
 * path filter can match a file that is in the folder now (find . -name '*.log' -delete is fine
 * when content/ has no .log files), or when nothing filters it.
 */
function findReaches(args, g, rootAbs) {
  const names = [];
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['-name', '-iname'].includes(a)) names.push(String(args[++i] || ''));
    else if (['-path', '-ipath', '-wholename'].includes(a)) paths.push(String(args[++i] || ''));
    else if (a === '-regex' || a === '-iregex') return true;
    else if (EXEC_FLAGS.includes(a)) {
      while (i < args.length && args[i] !== ';' && args[i] !== '+') i++;
    }
  }
  if (!names.length && !paths.length) return true;
  if (paths.some((p) => p.includes(g.prefix))) return true;
  const files = listFiles(path.posix.join(rootAbs, g.prefix)).map((f) => `${g.prefix}/${f}`);
  const test = (pattern, subject) => {
    try { return nameGlob(pattern).test(subject); } catch { return true; }
  };
  return files.some((f) => names.every((n) => test(n, path.posix.basename(f)))
    && paths.every((p) => test(p, `./${f}`) || test(p, f)));
}

/** Programs that change a file in place when given -i (sed -i, perl -pi, ruby -i). */
const IN_PLACE = new Set(['sed', 'gsed', 'perl', 'ruby']);
const inPlace = (args) => args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a));

/**
 * protect-path: deleting, moving or overwriting what a glob covers. With params.edits (a rule that
 * says "don't touch" or "never modify"), changing a file in place is held too: Edit, >>, tee -a,
 * sed -i, perl -pi, truncate, cp or mv over it, and write tools on MCP servers.
 * Paths are compared with symlinks resolved: a link into the folder (ln -s content c2; rm -rf c2/)
 * is the folder.
 */
export function protectPath(ctx) {
  const glob = ctx.params && ctx.params.glob;
  if (!glob) return null;
  const edits = !!ctx.params.edits;
  const g = pathGlob(glob);
  const r = toPosix(ctx.root);
  const rReal = realish(r);
  const links = {};
  // Every spelling of the path relative to the project: as written, and with symlinks resolved.
  const relsOf = (word, cwd, follow) => {
    const abs = resolveWord(word, cwd);
    if (abs === null) return null;
    const real = realPath(abs, { follow: follow || /\/$/.test(word), links });
    return [...new Set([path.posix.relative(r, abs), path.posix.relative(rReal, real)])];
  };
  const relOf = (word, cwd) => {
    const rels = relsOf(word, cwd, false);
    return rels && (rels.find((x) => g.covers(x)) ?? rels[0]);
  };
  const hit = (word, cwd, follow = false) => {
    const rels = relsOf(word, cwd, follow);
    return !!rels && rels.some((x) => g.covers(x));
  };
  const inGlob = (word, cwd) => {
    const rels = relsOf(word, cwd, true);
    return !!rels && rels.some((x) => g.within(x));
  };
  const exists = (w, cwd) => {
    const abs = resolveWord(w, cwd);
    try { return !!abs && fs.statSync(realPath(abs, { follow: true, links })).isFile(); } catch {
      return false;
    }
  };
  const cwd0 = ctx.cwd || ctx.root;
  const mcp = mcpName(ctx.tool);
  if (mcp) {
    const w = words(mcp.tool).slice(0, 2);
    const removes = w.some((x) => /^(delete|remove|move|rename|trash|unlink|rm)$/.test(x));
    const files = inputPaths(ctx.input);
    if (removes && files.some((f) => hit(f, cwd0))) {
      return hold('block', `${mcp.tool} under ${glob}`);
    }
    // write_file replaces a file (held when it exists); edit_file changes one (held with edits).
    const replaces = w.some((x) => /^(write|put|upload|replace|overwrite)$/.test(x));
    for (const f of mcpWrites(mcp.tool) ? files : []) {
      if (!inGlob(f, cwd0)) continue;
      if (edits || (replaces && exists(f, cwd0))) return hold('block', `${mcp.tool} on ${f}`);
    }
    return null;
  }
  if (FILE_WRITE_TOOLS.has(ctx.tool)) {
    const file = String(ctx.input.file_path || ctx.input.notebook_path || '');
    if (!file || !inGlob(file, cwd0)) return null;
    if (edits) return hold('block', `editing ${file}`);
    // Write replaces a whole file: overwriting one that exists is held. Edit changes part of one.
    return ctx.tool === 'Write' && exists(file, cwd0) ? hold('block', `overwriting ${file}`) : null;
  }
  if (ctx.tool !== 'Bash') return null;
  return eachCommand(ctx, ({ argv, redirects }, cwd) => {
    trackLink(argv, cwd, links);
    for (const x of redirects) {
      if (!WRITE_OPS.has(x.op) || /^\/dev\//.test(x.target)) continue;
      const append = x.op === '>>' || x.op === '&>>' || x.op === '<>';
      if (edits && inGlob(x.target, cwd)) return hold('block', `writing ${x.target}`);
      if (!append && hit(x.target, cwd, true) && exists(x.target, cwd)) {
        return hold('block', `overwriting ${x.target}`);
      }
    }
    const [bin, ...args] = argv;
    const pos = positionals(args);
    if (['rm', 'unlink', 'shred', 'rmdir'].includes(bin) && pos.some((a) => hit(a, cwd))) {
      return hold('block', `${bin} under ${glob}`);
    }
    if (bin === 'truncate' && pos.some((a) => hit(a, cwd, true))) {
      return hold('block', `truncate under ${glob}`);
    }
    if (bin === 'mv' && pos.slice(0, -1).some((a) => hit(a, cwd))) {
      return hold('block', `moving files out of ${glob}`);
    }
    if (['cp', 'mv', 'rsync', 'install', 'ditto'].includes(bin) && pos.length >= 2) {
      const dest = pos[pos.length - 1];
      if (hit(dest, cwd, true) && (exists(dest, cwd) || (edits && inGlob(dest, cwd)))) {
        return hold('block', `overwriting ${dest}`);
      }
      if (bin === 'rsync' && argv.some((a) => /^--delete/.test(a)) && hit(dest, cwd, true)) {
        return hold('block', `rsync --delete into ${glob}`);
      }
    }
    if (edits && bin === 'tee' && pos.some((a) => inGlob(a, cwd))) {
      return hold('block', `tee into ${glob}`);
    }
    if (edits && IN_PLACE.has(bin) && inPlace(args) && pos.some((a) => inGlob(a, cwd))) {
      return hold('block', `${bin} -i under ${glob}`);
    }
    if (edits && bin === 'dd') {
      const of = args.find((a) => a.startsWith('of='));
      if (of && inGlob(of.slice(3), cwd)) return hold('block', `dd into ${glob}`);
    }
    const gitPaths = bin === 'git' ? positionals(args.slice(1)) : [];
    if (['rm', 'mv'].includes(args[0]) && gitPaths.some((a) => hit(a, cwd))) {
      return hold('block', `git ${args[0]} under ${glob}`);
    }
    const short = shortFlags(args);
    if (bin === 'git' && args[0] === 'clean' && /f/.test(short) && !/n/.test(short)) {
      const p = positionals(args.slice(1));
      if ((p.length ? p : ['.']).some((a) => hit(a, cwd, true))) {
        return hold('block', `git clean under ${glob}`);
      }
    }
    const deletes = argv.includes('-delete') || argv.some((a, i) => EXEC_FLAGS.includes(a)
      && ['rm', 'unlink', 'shred'].includes(argv[i + 1]));
    if (bin === 'find' && deletes) {
      const starts = [];
      for (const a of args) {
        if (a.startsWith('-') || a === '(' || a === '!') break;
        starts.push(a);
      }
      for (const s of starts.length ? starts : ['.']) {
        const rel = relOf(s.replace(/\/?$/, '/'), cwd);
        if (rel === null) return hold('ask', `find -delete from a path set by a variable`);
        if (g.within(rel) || rel === g.prefix) return hold('block', `find -delete under ${glob}`);
        if (g.covers(rel) && findReaches(args.slice(starts.length), g, r)) {
          return hold('block', `find -delete that reaches ${glob}`);
        }
      }
    }
    return null;
  });
}
