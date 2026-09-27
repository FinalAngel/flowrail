// The read-only demo (GitHub Pages): the pages read the answers flowrailOS gave on the example
// workspace, saved as JSON by scripts/static-demo.js, instead of asking a server. Writes are refused.

const RUN = 'Run `npx @finalangel/flowrail-os demo` to try it on your machine.';
export const READ_ONLY = `This is a read-only demo. ${RUN}`;

// The query parameter that picks a different answer; every other parameter reads the same file.
const KEYED = { '/docs/file': 'path', '/comments': 'path', '/apps/log': 'id' };
const enc = (s) => encodeURIComponent(s).replace(/%/g, '~');

/** The file (under api/, without .json) that holds the answer to GET /api<path>. */
export function snapshotFile(path) {
  const [pathname, qs = ''] = path.split('?');
  const key = KEYED[pathname] && new URLSearchParams(qs).get(KEYED[pathname]);
  return pathname.slice(1).split('/').map(enc).join('/') + (key ? '/' + enc(key) : '');
}

const cache = new Map();
function load(file) {
  if (!cache.has(file)) {
    cache.set(file, fetch(`api/${file}.json`).then(async (res) => {
      if (!res.ok) throw Object.assign(new Error(`Not in this demo. ${RUN}`), { status: 404 });
      return res.json();
    }));
  }
  return cache.get(file).then((data) => {
    if (data && data.__error) throw Object.assign(new Error(data.__error), { status: data.status });
    return data;
  });
}

/** api(path, body) for the demo. */
export async function snapshot(path, body) {
  if (body !== undefined) throw Object.assign(new Error(READ_ONLY), { status: 405 });
  const [pathname, qs = ''] = path.split('?');
  const needle = (new URLSearchParams(qs).get('q') || '').toLowerCase().trim();
  if (pathname === '/search') {
    if (!needle) return [];
    return (await load('search-index')).filter((x) => x.text.toLowerCase().includes(needle)).slice(0, 30).map(({ text, ...hit }) => hit);
  }
  if (pathname === '/recall') {
    const { items = [] } = await load('memory');
    const hits = items.filter((m) => `${m.name} ${m.description} ${m.body || ''}`.toLowerCase().includes(needle));
    return { hits: needle ? hits.slice(0, 8).map((m) => ({ name: m.name, path: m.path, snippet: m.description, source: 'memory' })) : [] };
  }
  return load(snapshotFile(path));
}
