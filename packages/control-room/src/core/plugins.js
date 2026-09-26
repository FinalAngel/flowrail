// Plugins add pages and API routes to the control room without forking it.
//
// A plugin is a plain object (or a module whose default export is one):
//   {
//     id: 'crm',                                  // [a-z][a-z0-9-]*, unique
//     ui: '/abs/path/to/ui',                      // static files, served at /x/<id>/<file>
//     pages: [{ id: 'leads', title: 'Leads', path: '/leads', group: 'Now', icon: 'board', module: 'leads.js' }],
//     routes: { 'GET leads': (body, query, ctx) => ..., 'POST leads': (body, query, ctx) => ... },
//   }
// A route answers at /api/x/<id>/<name> behind the same Host, Origin, token and X-Flowrail checks as
// every built-in route. A page module lives in `ui` and exports mount(el, ctx) like the built-in pages.
// A page whose path equals a built-in page's path replaces that page.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ID = /^[a-z][a-z0-9-]{0,39}$/;
const ROUTE = /^(GET|POST) ([a-z0-9][a-z0-9/_-]*)$/;
const PAGE_PATH = /^\/[a-z0-9/_-]*$/;
const FILE = /^[\w.-]+(\/[\w.-]+)*\.m?js$/;

/** Check a plugin's shape; throws with the plugin id and what is wrong. */
export function validate(pl) {
  const where = `plugin ${JSON.stringify(pl?.id)}`;
  if (!pl || typeof pl !== 'object' || !ID.test(pl.id)) throw new Error(`${where}: id must match ${ID}`);
  if (pl.ui !== undefined && (typeof pl.ui !== 'string' || !path.isAbsolute(pl.ui))) throw new Error(`${where}: ui must be an absolute folder path`);
  for (const pg of pl.pages || []) {
    if (!ID.test(pg.id) || typeof pg.title !== 'string' || !PAGE_PATH.test(pg.path || '')) throw new Error(`${where}: page needs id, title and a path like /leads`);
    if (!pl.ui || !FILE.test(pg.module || '') || pg.module.includes('..')) throw new Error(`${where}: page ${pg.id} needs ui and a module like leads.js`);
  }
  for (const [key, fn] of Object.entries(pl.routes || {})) {
    if (!ROUTE.test(key) || key.includes('..')) throw new Error(`${where}: route "${key}" must look like "GET name" or "POST name/sub"`);
    if (typeof fn !== 'function') throw new Error(`${where}: route "${key}" is not a function`);
  }
  return pl;
}

const STORE_METHODS = { board: ['read', 'create', 'update', 'note', 'trash'], memory: ['list', 'recall', 'store'] };

/** The data stores plugins supply (`stores: { board }`); one plugin per store. */
export function stores(plugins) {
  const out = {};
  for (const pl of plugins) {
    for (const [name, store] of Object.entries(pl.stores || {})) {
      const need = STORE_METHODS[name];
      if (!need) throw new Error(`plugin "${pl.id}": unknown store "${name}" (known: ${Object.keys(STORE_METHODS).join(', ')})`);
      const missing = need.filter((m) => typeof store?.[m] !== 'function');
      if (missing.length) throw new Error(`plugin "${pl.id}": store ${name} needs ${missing.join(', ')}`);
      if (out[name]) throw new Error(`store ${name} is supplied by two plugins`);
      out[name] = store;
    }
  }
  return out;
}

/** Validate a list and refuse duplicate ids. */
export function prepare(plugins = []) {
  const seen = new Set();
  return plugins.map((pl) => {
    validate(pl);
    if (seen.has(pl.id)) throw new Error(`plugin "${pl.id}" is loaded twice`);
    seen.add(pl.id);
    return pl;
  });
}

/** Import the plugins listed in flowrail/config.json "plugins" (paths relative to the repo, inside it). */
export async function fromConfig(root, list = []) {
  const out = [];
  for (const rel of list) {
    const file = path.resolve(root, String(rel));
    if (!file.startsWith(path.resolve(root) + path.sep)) throw new Error(`plugin ${rel} is outside the repo`);
    const mod = await import(pathToFileURL(file).href);
    out.push(mod.default || mod.plugin);
  }
  return out;
}

/** What the page needs to draw the nav and load the modules. */
export const describe = (plugins) => plugins.map((pl) => ({
  id: pl.id,
  pages: (pl.pages || []).map(({ id, title, path: p, group, icon, module }) => ({ id: `${pl.id}:${id}`, title, path: p, group: group || null, icon: icon || null, module: `/x/${pl.id}/${module}` })),
}));
