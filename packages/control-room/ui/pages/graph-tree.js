// Tree: every folder and document the map knows, as a collapsible tree with counts and the area a
// folder or file belongs to. ARIA tree pattern: one tab stop, arrows move, Right opens, Left closes
// or goes to the parent, Enter opens the document. #/knowledge?view=tree&path=docs opens at a path.
import { h, clear, skeleton, errorBox, empty } from '../lib/dom.js';

const AREA_COLORS = 8;

export function tree(el, ctx) {
  let root = null, areas = [], active = null;
  const open = new Set(['']);
  const box = h('div.card.map-tree');
  el.append(box);
  box.append(skeleton(8));

  async function load() {
    let graph;
    try { graph = await ctx.api('/graph'); } catch (e) { clear(box).append(errorBox(e, load)); return; }
    areas = graph.areas || [];
    const files = graph.nodes.filter((n) => n.path && n.kind !== 'folder' && n.kind !== 'hub' && !/\.json$/.test(n.path));
    if (!files.length) { clear(box).append(empty('The tree fills as you add Markdown docs to the repo.', 'npx @finalangel/flowrail-room remember "Releases go out on Tuesdays" --type project --name release-day', ctx)); return; }
    const areaOfDir = new Map(graph.nodes.filter((n) => n.kind === 'folder' && n.area != null).map((n) => [n.path, n.area]));
    root = { name: '', path: '', dirs: new Map(), files: [], count: 0 };
    for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
      const parts = f.path.split('/');
      let cur = root;
      cur.count++;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        if (!cur.dirs.has(parts[i])) cur.dirs.set(parts[i], { name: parts[i], path: p, dirs: new Map(), files: [], count: 0, area: areaOfDir.get(p) });
        cur = cur.dirs.get(parts[i]);
        cur.count++;
      }
      cur.files.push(f);
    }
    const want = ctx.params.get('path');
    if (want) { const parts = want.split('/'); for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join('/')); active = want; }
    paint();
  }

  const chip = (a) => (a == null || a < 0 ? null : h('span.chip.area', { style: `--c:var(--area-${(a % AREA_COLORS) + 1})` }, areas[a]?.name || ''));

  function paint() {
    const ul = h('ul', { role: 'tree', 'aria-label': 'Folders and documents' });
    const items = [];
    const walk = (dir, level, parentArea, into) => {
      for (const d of [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const expanded = open.has(d.path);
        const li = h('li', { role: 'treeitem', 'aria-expanded': String(expanded), 'aria-level': String(level), 'data-path': d.path, tabindex: '-1' },
          h('div.tn', { style: `--lvl:${level - 1}` }, h('span.tw', { 'aria-hidden': 'true' }, expanded ? '▾' : '▸'), h('span.t', d.name + '/'), d.area !== parentArea && chip(d.area), h('span.n', d.count)));
        items.push({ li, path: d.path, dir: true, parent: dir.path });
        into.append(li);
        if (expanded) {
          const sub = h('ul', { role: 'group' });
          li.append(sub);
          walk(d, level + 1, d.area ?? parentArea, sub);
        }
      }
      for (const f of dir.files) {
        const name = f.path.split('/').pop();
        const li = h('li', { role: 'treeitem', 'aria-level': String(level), 'data-path': f.path, tabindex: '-1' },
          h('div.tn', { style: `--lvl:${level - 1}` }, h('span.tw', { 'aria-hidden': 'true' }), h('span.t', name), f.area !== parentArea && chip(f.area)));
        items.push({ li, path: f.path, dir: false, parent: dir.path });
        into.append(li);
      }
    };
    walk(root, 1, undefined, ul);
    const target = items.find((x) => x.path === active) || items[0];
    active = target.path;
    target.li.tabIndex = 0;
    target.li.setAttribute('aria-selected', 'true');
    clear(box).append(h('p.meta', `${root.count} documents${areas.length ? ` in ${areas.length} areas` : ''}`), ul);
    ul.addEventListener('click', (e) => {
      const li = e.target.closest('[role=treeitem]');
      if (!li) return;
      const it = items.find((x) => x.li === li);
      e.stopPropagation();
      activate(it, items);
    });
    ul.addEventListener('keydown', (e) => keys(e, items));
    return ul;
  }

  function activate(it, items) {
    active = it.path;
    if (it.dir) { open.has(it.path) ? open.delete(it.path) : open.add(it.path); paint(); focusActive(); return; }
    void items;
    ctx.navigate('#/docs?path=' + encodeURIComponent(it.path));
  }
  const focusActive = () => box.querySelector(`[role=treeitem][tabindex="0"]`)?.focus();

  function keys(e, items) {
    const i = items.findIndex((x) => x.path === active);
    const it = items[i];
    const go = (j) => { if (j < 0 || j >= items.length) return; active = items[j].path; paint(); focusActive(); };
    switch (e.key) {
      case 'ArrowDown': go(i + 1); break;
      case 'ArrowUp': go(i - 1); break;
      case 'Home': go(0); break;
      case 'End': go(items.length - 1); break;
      case 'ArrowRight':
        if (it.dir && !open.has(it.path)) { open.add(it.path); paint(); focusActive(); } else if (it.dir) go(i + 1);
        break;
      case 'ArrowLeft':
        if (it.dir && open.has(it.path)) { open.delete(it.path); paint(); focusActive(); } else if (it.parent) { active = it.parent; paint(); focusActive(); }
        break;
      case 'Enter': case ' ': activate(it, items); break;
      default: return;
    }
    e.preventDefault();
  }

  load();
  const unmount = () => {};
  unmount.update = (params) => { const p = params.get('path'); if (p && root) { const parts = p.split('/'); for (let i = 1; i <= parts.length; i++) open.add(parts.slice(0, i).join('/')); active = p; paint(); } };
  return unmount;
}
