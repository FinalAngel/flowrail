// flowrail dashboard server. node:http, loopback only, zero dependencies.
//
// Static paths:
//   GET /                   -> ui/index.html
//   GET /ui/<file>          -> ui/<file> (app.css, app.js, pages/*.js, fonts/*, favicon.svg, ...)
//   GET /favicon.ico        -> ui/favicon.svg when present, else 204
//   GET /x/<plugin>/<file>  -> a plugin's static files (see src/core/plugins.js), same CSP as /ui
//   GET /artifacts/<name>   -> flowrail/artifacts/<name>.html, served with a sandbox CSP (scripts, no popups,
//                              own origin) and connect-src 'none', so a report cannot call the API or read the page
//   /api/*                  -> JSON API (see docs/api.md), /api/events is Server-Sent Events
//
// Security: binds 127.0.0.1; refuses a Host header that is not 127.0.0.1:<port> or localhost:<port> (421,
// DNS rebinding); refuses a foreign Origin (403); every /api request needs the per-launch token (401):
// header X-Flowrail-Token, or ?token= on /api/events; every non-GET also needs "X-Flowrail: 1" (403, CSRF).
// The token is random per launch, lives only in memory and in the served index.html, and is never logged.
// File access goes through safePath(); deletes move to .flowrail/trash/.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as redlines from 'flowrail/api';
import { paths, PathError, hooksStatus, hooksSummary, auditSummary, doctor, testCommand, verifyRedlines } from 'flowrail/api';
import { loadConfig, saveConfig } from 'flowrail/api';
import { PKG_ROOT, VERSION } from './core/pkg.js';
import * as board from './core/board.js';
import * as github from './core/github.js';
import * as docs from './core/docs.js';
import * as comments from './core/comments.js';
import * as memory from './core/memory.js';
import * as workflows from './core/workflows.js';
import * as routines from './core/routines.js';
import * as artifacts from './core/artifacts.js';
import * as runs from './core/runs.js';
import * as apps from './core/apps.js';
import * as actions from './core/actions.js';
import { team } from './core/team.js';
import { build as buildGraph } from './core/graph.js';
import { overview, search, drift } from './core/overview.js';
import { today, parseSince } from './core/today.js';
import { watch } from './core/events.js';
import { readJson } from 'flowrail/api';
import * as plugins from './core/plugins.js';
import { auditAsync } from './core/audit-worker.js';
import * as library from './core/library.js';

const UI_DIR = path.join(PKG_ROOT, 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const APP_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const ARTIFACT_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'";
const BODY_CAP = 1024 * 1024;
const DOCS_BODY_CAP = 2.5 * 1024 * 1024;

export const THREAT_MODEL = [
  'The server listens on 127.0.0.1 only. Nothing is reachable from your network.',
  'A Host header other than 127.0.0.1 or localhost on this port is refused, which stops DNS rebinding.',
  'Every API call needs a random token that is made fresh each time flowrail starts and is only handed to the dashboard page. Every write also needs the X-Flowrail header, which a page on another origin cannot send without a CORS preflight that flowrail never answers.',
  'Command routines cannot be created or changed over the API; they live in flowrail/routines.json and are scheduled from the terminal after you see each command.',
  'The dashboard can add red lines and make them stricter, never weaker: removing or loosening a line over the API is refused (409), so an agent that finds the token cannot switch the guard off. Every change is logged in .flowrail/redlines.log and in a hash-chained journal outside the repo.',
  'Artifacts open in a sandbox with an origin of their own and no fetch, XHR or WebSocket access (connect-src none), and they cannot open windows: they cannot call the API or read the dashboard or your files. A script in an artifact can still navigate its own frame, so the only data it could leak is what the artifact already contains.',
  'Files that look like secrets (.env, keys, credentials) and folders like .git and node_modules are never served.',
  'Deletes move files to .flowrail/trash/. Nothing is removed for good.',
  'Red lines are enforced by a Claude Code PreToolUse hook: code, not a prompt. They are a seatbelt, not a jail: a model that writes a script and runs it can do what the script does. Pair them with Claude Code permissions and review.',
];

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function send(res, status, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const payload = isBuf || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': isBuf || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(payload);
}

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > cap) { reject(new HttpError(413, `request body is larger than ${Math.round(cap / 1024)} KB`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'body must be JSON')); }
    });
    req.on('error', reject);
  });
}

function need(v, name) {
  if (v === undefined || v === null || v === '') throw new HttpError(400, `${name} is required`);
  return v;
}

/** Build the request handler for a workspace. `getPort` returns the bound port (for the Host check). */
export function createApp(root, getPort, { auditEnv = process.env, plugins: extra = [] } = {}) {
  const exts = plugins.prepare(extra);
  const p = { ...paths(root), stores: plugins.stores(exts) };
  const tasks = () => board.storeFor(p);
  const mem = () => memory.memoryFor(p);
  // Where artifacts and links live: config "artifactsDir" and "linksFile" (inside the repo), else flowrail/.
  const inRepo = (rel) => typeof rel === 'string' && rel.trim() && !path.isAbsolute(rel) && !rel.split(/[\\/]/).includes('..') && path.join(root, rel);
  { const c = loadConfig(p); p.artifacts = inRepo(c.artifactsDir) || p.artifacts; p.links = inRepo(c.linksFile) || p.links; p.agents = inRepo(c.agentsDir) || p.agents; docs.setRoots(root, c.docsRoots); }
  const token = crypto.randomBytes(32).toString('hex');
  const tokenOk = (t) => typeof t === 'string' && t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
  const clients = new Set();
  const broadcast = (area) => {
    const msg = `event: change\ndata: ${JSON.stringify({ area })}\n\n`;
    for (const res of clients) res.write(msg);
  };
  let stopWatch = null;

  const routes = {
    'GET /api/overview': () => overview(p),
    'GET /api/today': (_b, q) => {
      // A browser with no earlier visit gets the demo's seeded one, so the example shows "While you were away".
      const seeded = !q.get('since') && loadConfig(p).demo ? parseSince(loadConfig(p).lastVisit) : null;
      const r = today(p, new Date(), { since: seeded || parseSince(q.get('since')) });
      return seeded ? { ...r, away: r.since } : r;
    },
    'GET /api/audit': async (_b, q) => ({ ...await auditAsync(root, { days: Number(q.get('days')) || 30, env: auditEnv }), demo: !!loadConfig(p).demo }),
    'GET /api/config': () => ({ ...loadConfig(p), version: VERSION }),
    'POST /api/config': (b) => saveConfig(p, b),

    'GET /api/board': () => tasks().read(),
    'POST /api/board': (b) => {
      switch (b._action) {
        case 'create': return tasks().create({ ...b, createdBy: b.createdBy === 'agent' ? 'agent' : 'human' });
        case 'update': { const { _action, id, ...fields } = b; return tasks().update(need(id, 'id'), fields, 'human'); }
        case 'note': return tasks().note(need(b.id, 'id'), b.text, b.by || 'you');
        case 'trash': return tasks().trash(need(b.id, 'id'));
        default: throw new HttpError(400, '_action must be create, update, note or trash');
      }
    },

    // Read-only GitHub issues for the current sprint (config "github"); nothing is written back.
    'GET /api/board/issues': async (_b, q) => {
      const config = loadConfig(p);
      const r = await github.fetchIssues(p, config, { force: q.get('refresh') === '1' });
      if (!r) return { configured: false, issues: [] };
      return { configured: true, ...r, issues: github.forSprint(r.issues, tasks().read().config.current) };
    },

    'GET /api/docs/tree': () => docs.tree(root),
    'GET /api/docs/file': (_b, q) => docs.readDoc(root, need(q.get('path'), 'path')),
    'POST /api/docs/file': (b) => {
      if (b._action === 'create') return docs.createDoc(root, need(b.path, 'path'), b.text);
      if (b._action === 'trash') return docs.trashDoc(root, need(b.path, 'path'));
      return docs.writeDoc(root, need(b.path, 'path'), b.text, b.mtime);
    },

    'GET /api/comments': (_b, q) => (q.get('path') ? comments.forPath(p, q.get('path')) : comments.open(p)),
    'POST /api/comments': (b) => {
      switch (b._action) {
        case 'add': return comments.add(p, { path: need(b.path, 'path'), quote: b.quote, body: b.body, anchor: b.anchor, author: b.author || 'you' });
        case 'resolve': return comments.resolve(p, need(b.path, 'path'), need(b.id, 'id'), b.note, b.by || 'you');
        case 'reopen': return comments.reopen(p, need(b.path, 'path'), need(b.id, 'id'));
        case 'delete': return comments.remove(p, need(b.path, 'path'), need(b.id, 'id'));
        default: throw new HttpError(400, '_action must be add, resolve, reopen or delete');
      }
    },

    'GET /api/memory': () => ({ items: mem().list(), types: memory.TYPES }),
    'GET /api/recall': (_b, q) => ({ hits: mem().recall(q.get('q') || '', Number(q.get('limit')) || 8) }),
    'POST /api/memory': (b) => {
      if (b._action === 'store') return mem().store({ name: b.name, type: b.type, description: b.description, body: b.body, force: !!b.force });
      if (b._action === 'trash') {
        if (!mem().trash) throw new HttpError(405, 'this memory store does not trash');
        return mem().trash(need(b.name, 'name'));
      }
      throw new HttpError(400, '_action must be store or trash');
    },

    'GET /api/redlines': () => {
      let lines = [];
      let errors = [];
      try { lines = redlines.loadLines(p); errors = redlines.validateLines(lines); } catch (e) { errors = [e.message]; }
      const hs = hooksStatus(p);
      const cached = redlines.cachedChecks(p);
      return {
        lines: redlines.describeRedlines(lines, hs.healthy),
        errors,
        stats: redlines.stats(p),
        events: redlines.holds(p).slice(-50).reverse(),
        changes: redlines.changes(p).slice(-5).reverse(),
        hooksInstalled: hs.healthy,
        hooksState: hooksSummary(hs),
        hooks: hs.events,
        checkResults: cached.results,
        checkRanAt: cached.ranAt,
        headless: runs.HEADLESS,
        drift: drift(p, hs),
      };
    },
    'POST /api/redlines': async (b) => {
      if (b._action === 'save') {
        let before = [];
        try { before = redlines.loadLines(p); } catch { /* replacing a broken file */ }
        const had = new Set(before.map((l) => l && l.id));
        // Drop the derived fields describe() adds, and the built-in floor line it lists when the
        // file does not have it, so the file stays what the user wrote.
        const lines = Array.isArray(b.lines) ? b.lines.filter((l) => !(l && l.floor && !had.has(l.id))).map(({ links, state, summary, builtin, floor, ...l }) => l) : b.lines;
        const errors = redlines.validateLines(lines);
        if (errors.length) throw new HttpError(400, errors[0], { errors });
        // The API can add and tighten, never weaken: an agent that scrapes the token cannot use it
        // to switch a red line off. Weakening is a hand edit of the file, which the guard asks about.
        const weaker = redlines.weakenings(before, lines);
        if (weaker.length) throw new HttpError(409, `Edit flowrail/red-lines.json yourself to weaken a rule (the agent will be asked first). Refused: ${weaker.join('; ')}.`, { weakenings: weaker });
        fs.writeFileSync(p.redlines, JSON.stringify(lines, null, 2) + '\n');
        const change = redlines.logChange(p, before, lines, 'dashboard');
        return { ok: true, lines, change };
      }
      if (b._action === 'test') {
        const tool = b.tool || 'Bash';
        return testCommand(p, { tool, subject: b.subject ?? '' });
      }
      if (b._action === 'check') return redlines.runChecks(p);
      if (b._action === 'verify') {
        // The guard's own probes: every rule against commands it must hold and ones it must allow.
        return verifyRedlines(p);
      }
      throw new HttpError(400, '_action must be save, test, check or verify');
    },

    'GET /api/graph': () => buildGraph(p),
    'GET /api/workflows': () => workflows.list(p),

    'GET /api/routines': async () => {
      if (routines.routinesFor(p)) return routines.list(p);
      const gh = await routines.githubRuns(p);
      return routines.list(p).map((r) => (gh[r.id] ? { ...r, github: gh[r.id] } : r));
    },
    'POST /api/routines': async (b) => {
      const store = routines.routinesFor(p);
      if (store) {
        if (b._action === 'run') return store.runNow(need(b.id, 'id'));
        throw new HttpError(405, 'these routines are scheduled by the repo itself, not from here');
      }
      switch (b._action) {
        case 'run': return routines.runNow(p, need(b.id, 'id'), { wait: false });
        case 'install': return routines.install(p, { http: true });
        case 'uninstall': return routines.uninstall(p);
        case 'save': return routines.saveFromApi(p, b.routines);
        case 'delete': return routines.deleteFromApi(p, need(b.id, 'id'));
        default: throw new HttpError(400, '_action must be run, install, uninstall, save or delete');
      }
    },

    'GET /api/team': () => team(p),
    'GET /api/artifacts': () => artifacts.list(p),
    'POST /api/artifacts': (b) => {
      if (b._action === 'trash') return artifacts.trash(p, need(b.name, 'name'));
      throw new HttpError(400, '_action must be trash');
    },
    'GET /api/links': () => library.links(p, readJson),
    'GET /api/library': () => library.library(root, loadConfig(p)),
    'GET /api/context': () => library.context(root, loadConfig(p)),
    'GET /api/runs': () => runs.list(p),
    // The Runs page in one call: recorded runs, what a headless run may do, and the apps.
    'GET /api/automation': async () => {
      let appList = [];
      let appsError = null;
      try { appList = await apps.list(p); } catch (e) { appsError = e.message; }
      let actionList = [];
      let actionsError = null;
      try { actionList = actions.list(p); } catch (e) { actionsError = e.message; }
      return { runs: runs.list(p), headless: runs.HEADLESS, apps: appList, appsError, actions: actionList, actionsError };
    },
    // Apps are started and stopped by id; the list itself lives in flowrail/config.json only.
    'GET /api/actions': () => actions.list(p),
    // Run an action by id with its inputs; actions themselves live in flowrail/config.json only.
    'POST /api/actions': (b) => actions.run(p, need(b.id, 'id'), b.inputs || {}),
    'POST /api/apps': (b) => {
      if (b._action === 'start') return apps.start(p, need(b.id, 'id'));
      if (b._action === 'stop') return apps.stop(p, need(b.id, 'id'));
      throw new HttpError(400, '_action must be start or stop; apps are added in flowrail/config.json only');
    },
    'GET /api/apps/log': (_b, q) => ({ id: q.get('id'), log: apps.log(p, need(q.get('id'), 'id')) }),
    'GET /api/search': (_b, q) => search(p, q.get('q')),
    'GET /api/plugins': () => plugins.describe(exts),
    'GET /api/doctor': async () => ({ checks: [...await doctor(p, { serving: true }), ...(routines.routinesFor(p) ? [] : routines.doctorChecks(p))], headless: runs.HEADLESS, threatModel: THREAT_MODEL, server: { host: '127.0.0.1', port: getPort() } }),
  };

  for (const pl of exts) {
    const ctx = { root, paths: p, broadcast, HttpError };
    for (const [key, fn] of Object.entries(pl.routes || {})) {
      const [method, name] = key.split(' ');
      routes[`${method} /api/x/${pl.id}/${name}`] = (b, q) => fn(b, q, ctx);
    }
  }

  function checkRequest(req, pathname, url) {
    const port = getPort();
    const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowed.includes(String(req.headers.host || '').toLowerCase())) throw new HttpError(421, 'unexpected Host header; open flowrail at http://127.0.0.1:' + port);
    const origin = req.headers.origin;
    if (origin && !allowed.some((a) => origin === `http://${a}`)) throw new HttpError(403, 'cross-origin requests are refused');
    if (pathname.startsWith('/api/') || pathname === '/api') {
      const given = pathname === '/api/events' && req.method === 'GET' ? url.searchParams.get('token') : req.headers['x-flowrail-token'];
      if (!tokenOk(given)) throw new HttpError(401, 'token');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-flowrail'] !== '1') throw new HttpError(403, 'missing X-Flowrail header');
  }

  function serveFile(res, file, headers = {}) {
    let data;
    try { data = fs.readFileSync(file); } catch { return send(res, 404, { error: 'not found' }); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', ...headers });
    res.end(data);
  }

  function serveUi(res, rel, dir = UI_DIR) {
    const uiReal = fs.existsSync(dir) ? fs.realpathSync(dir) : dir;
    const file = path.join(uiReal, rel);
    if (rel.includes('\0') || !file.startsWith(uiReal + path.sep)) return send(res, 404, { error: 'not found' });
    let real;
    try { real = fs.realpathSync(file); } catch { return send(res, 404, { error: 'not found' }); }
    if (!real.startsWith(uiReal + path.sep) || !fs.statSync(real).isFile()) return send(res, 404, { error: 'not found' });
    serveFile(res, real, { 'Content-Security-Policy': APP_CSP });
  }

  // The page gets the token in a meta tag; nothing else does. It is only ever sent to a same-origin
  // request that passed the Host check, so another website cannot read it.
  function serveIndex(res) {
    const meta = `<meta name="flowrail-token" content="${token}">`;
    let html;
    try { html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8'); } catch { html = null; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': APP_CSP });
    if (html) return res.end(/<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}\n${meta}`) : meta + html);
    res.end('<!doctype html><meta charset="utf-8">' + meta + '<title>flowrail</title><body style="font:15px system-ui;padding:48px;max-width:640px;margin:auto"><h1>flowrail</h1><p>The API is running, but the dashboard files (ui/index.html) are missing from this install. Try <code>npx @finalangel/flowrail-room@latest</code>.</p></p>');
  }

  function events(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\nevent: hello\ndata: {}\n\n');
    clients.add(res);
    if (!stopWatch) stopWatch = watch(root, broadcast);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  }

  async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { throw new HttpError(400, 'malformed URL'); }
      checkRequest(req, pathname, url);

      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') return serveIndex(res);
        if (pathname.startsWith('/ui/')) return serveUi(res, pathname.slice(4));
        if (pathname.startsWith('/x/')) {
          const [, , id, ...rest] = pathname.split('/');
          const pl = exts.find((x) => x.id === id && x.ui);
          return pl ? serveUi(res, rest.join('/'), pl.ui) : send(res, 404, { error: 'not found' });
        }
        const own = exts.find((x) => x.prefixes?.some((pre) => pathname.startsWith(pre)));
        if (own && !['/api/', '/ui/', '/x/', '/artifacts/'].some((pre) => pathname.startsWith(pre))) return await own.handle(req, res, { kind: 'file', rest: pathname });
        if (pathname === '/favicon.ico') return fs.existsSync(path.join(UI_DIR, 'favicon.svg')) ? serveUi(res, 'favicon.svg') : send(res, 204, '');
        if (pathname.startsWith('/artifacts/')) {
          const file = artifacts.fileFor(p, pathname.slice('/artifacts/'.length));
          if (!file) return send(res, 404, { error: 'no such artifact' });
          try { if (fs.statSync(file).nlink > 1) return send(res, 403, { error: 'artifact is a hard link to another file and is not served' }); } catch { /* serveFile answers 404 */ }
          res.removeHeader('X-Frame-Options');
          return serveFile(res, file, { 'Content-Security-Policy': ARTIFACT_CSP, 'X-Frame-Options': 'SAMEORIGIN' });
        }
        if (pathname === '/api/events') return events(req, res);
        if (pathname.startsWith('/api/runs/')) {
          const run = runs.get(p, pathname.slice('/api/runs/'.length));
          return run ? send(res, 200, run) : send(res, 404, { error: 'no such run' });
        }
      }

      const route = routes[`${req.method === 'HEAD' ? 'GET' : req.method} ${pathname}`];
      if (!route && pathname.startsWith('/api/x/')) {
        const [, , , id, ...rest] = pathname.split('/');
        const pl = exts.find((x) => x.id === id && x.handle);
        if (pl) return await pl.handle(req, res, { kind: 'api', rest: '/' + rest.join('/') });
      }
      if (!route) {
        const other = routes[`${req.method === 'GET' ? 'POST' : 'GET'} ${pathname}`];
        return send(res, other ? 405 : 404, { error: other ? 'method not allowed' : 'not found' });
      }
      const body = req.method === 'POST' ? await readBody(req, pathname === '/api/docs/file' ? DOCS_BODY_CAP : BODY_CAP) : {};
      const data = await route(body, url.searchParams);
      send(res, 200, data ?? { ok: true });
    } catch (err) {
      const status = err.status || (err.code === 'EBADJSON' ? 422 : 500);
      if (status >= 500) console.error('flowrail:', err);
      if (!res.headersSent) send(res, status, { error: status >= 500 && !err.status ? 'internal error; see the terminal running flowrail' : err.message, ...(err.extra || {}), ...(err.mtime ? { mtime: err.mtime } : {}) });
      else res.end();
    }
  }

  handle.token = token;
  handle.close = () => {
    if (stopWatch) stopWatch();
    for (const res of clients) res.end();
    clients.clear();
  };
  return handle;
}

/**
 * Start the server on the first free port from `port` to `port + tries - 1`.
 * @returns {Promise<{server: http.Server, token: string, port: number, url: string, close: () => Promise<void>, tried: number[]}>}
 */
export async function startServer({ root, port = 4747, tries = 11, auditEnv, plugins: extra }) {
  let bound = port;
  const app = createApp(root, () => bound, { auditEnv, plugins: extra });
  const server = http.createServer(app);
  server.keepAliveTimeout = 5000;
  const tried = [];
  for (let i = 0; i < tries; i++) {
    bound = port + i;
    tried.push(bound);
    const ok = await new Promise((resolve, reject) => {
      const onError = (e) => { server.off('listening', onListening); e.code === 'EADDRINUSE' || e.code === 'EACCES' ? resolve(false) : reject(e); };
      const onListening = () => { server.off('error', onError); resolve(true); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(bound, '127.0.0.1');
    });
    if (ok) {
      if (port === 0) bound = server.address().port;
      return {
        server,
        token: app.token,
        port: bound,
        url: `http://127.0.0.1:${bound}`,
        tried,
        close: () => new Promise((resolve) => { app.close(); server.closeAllConnections?.(); server.close(() => resolve()); }),
      };
    }
  }
  throw new Error(`ports ${port} to ${port + tries - 1} are all in use; pass --port`);
}

export { PathError };
