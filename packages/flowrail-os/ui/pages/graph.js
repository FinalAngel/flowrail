import { h, icon, clear, skeleton, errorBox, empty } from '../lib/dom.js';
import { rings } from './graph-rings.js';
import { tree } from './graph-tree.js';

const KINDS = [
  ['doc', 'Docs'], ['folder', 'Folders'], ['memory', 'Memories'], ['skill', 'Skills'],
  ['agent', 'Agents'], ['workflow', 'Workflows'], ['routine', 'Routines'], ['redline', 'Red lines'],
];
const SHAPE = { hub: 'hub', doc: 'circle', folder: 'square', memory: 'diamond', skill: 'triangle', agent: 'hexagon', workflow: 'pentagon', routine: 'ring', redline: 'bars' };
const MAX_NODES = 1500;
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function shapeSvg(kind) {
  const s = SHAPE[kind];
  const d = { circle: '<circle cx="6" cy="6" r="4" fill="currentColor"/>', square: '<rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.5" fill="currentColor"/>', diamond: '<path d="M6 1.5L10.5 6 6 10.5 1.5 6z" fill="currentColor"/>',
    triangle: '<path d="M6 1.8l4.6 8H1.4z" fill="currentColor"/>', hexagon: '<path d="M6 1.5l3.9 2.25v4.5L6 10.5 2.1 8.25v-4.5z" fill="currentColor"/>', pentagon: '<path d="M6 1.5l4.3 3.1-1.6 5.1H3.3L1.7 4.6z" fill="currentColor"/>',
    ring: '<circle cx="6" cy="6" r="3.6" fill="none" stroke="currentColor" stroke-width="1.8"/>', bars: '<path d="M3.5 1.5v9M8.5 1.5v9" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>' }[s] || '';
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 12 12'); el.setAttribute('width', '12'); el.setAttribute('height', '12'); el.setAttribute('aria-hidden', 'true');
  el.innerHTML = d; // trusted constant
  return el;
}

const VIEWS = [['graph', 'Graph', 'Docs, memories and automation, linked by Markdown links, [[wikilinks]] and folders.'],
  ['rings', 'Rings', 'The repo in rings: skills, areas, documents, routines and artifacts around CLAUDE.md.'],
  ['tree', 'Tree', 'Every folder and document, with the area it belongs to.']];
const PREF = 'flowrail-map-view';
const known = (v) => VIEWS.some(([k]) => k === v);

// Graph | Rings | Tree. The view is in the address (#/knowledge?view=rings) and remembered per browser.
export function mount(el, ctx) {
  const pick = (params) => {
    const v = params.get('view');
    if (known(v)) return v;
    try { const s = localStorage.getItem(PREF); if (known(s)) return s; } catch { /* private mode */ }
    return 'graph';
  };
  let view = pick(ctx.params), child = null;
  const sub = h('p.sub');
  const seg = h('div.seg', { role: 'group', 'aria-label': 'View' });
  const host = h('div');
  el.append(h('header.page-head', h('div', h('h1', 'Graph'), sub)), host);
  // The view switch sits in the header, next to the search.
  ctx.header?.({ tools: seg });
  const show = (params) => {
    try { child?.(); } catch (e) { console.error(e); }
    try { localStorage.setItem(PREF, view); } catch { /* private mode */ }
    sub.textContent = VIEWS.find(([k]) => k === view)[2];
    clear(seg).append(...VIEWS.map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === view), onclick: () => ctx.navigate(`#/knowledge?view=${k}`) }, label)));
    clear(host);
    child = ({ graph: force, rings, tree })[view](host, { ...ctx, params });
  };
  show(ctx.params);
  const unmount = () => child?.();
  unmount.update = (params) => {
    const v = pick(params);
    if (v !== view) { view = v; show(params); } else child?.update?.(params);
  };
  return unmount;
}

function force(el, ctx) {
  let graph = null, byId = new Map(), adj = new Map();
  const on = new Set(KINDS.map(([k]) => k));
  let showAll = false, focusId = null, selected = null, hover = null;
  const pos = new Map(); // id -> {x,y,vx,vy,fx,fy}
  let vis = [], visLinks = [], alpha = 0, raf = 0, colors = {};
  const view = { x: 0, y: 0, k: 1 };

  const body = h('div');
  el.append(body);

  const canvas = h('canvas', { tabindex: '0', role: 'img', 'aria-label': 'Knowledge graph. Use the search field or the detail panel to move between nodes. Arrow keys pan, plus and minus zoom.' });
  const status = h('div.canvas-status', { 'aria-live': 'polite' });
  const box = h('div.canvas-box', canvas, status,
    h('div.canvas-tools',
      h('button.icon-btn', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.25) }, icon('zoomIn')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomBy(0.8) }, icon('zoomOut')),
      h('button.icon-btn', { type: 'button', 'aria-label': 'Fit to view', onclick: () => fit() }, icon('fit'))));
  const detail = h('section.card', { 'aria-live': 'polite' });
  const legend = h('div.legend', { role: 'group', 'aria-label': 'Show node types' });
  const allToggle = h('label.switch', h('input', { type: 'checkbox', onchange: (e) => { showAll = e.target.checked; rebuild(); } }), 'Show all');
  const search = h('input.input', { type: 'search', placeholder: 'Find a node', 'aria-label': 'Find a node', list: 'graph-nodes' });
  const datalist = h('datalist', { id: 'graph-nodes' });
  search.addEventListener('change', () => {
    const q = search.value.trim().toLowerCase();
    const n = graph?.nodes.find((x) => x.label.toLowerCase() === q) || graph?.nodes.find((x) => x.label.toLowerCase().includes(q) || (x.path || '').toLowerCase().includes(q));
    if (n) { focusOn(n.id); search.value = ''; }
  });
  const tray = h('aside.graph-tray.tray', { style: 'padding:10px', 'aria-label': 'Graph filters' }, search, datalist, allToggle, legend, detail);

  /* ---------- data ---------- */
  async function load() {
    clear(body).append(skeleton(6));
    try { graph = await ctx.api('/graph'); }
    catch (e) { clear(body).append(errorBox(e, load)); return; }
    if (!body.isConnected) return; // switched to another view while it loaded
    if (graph.nodes.length > MAX_NODES) graph.nodes = graph.nodes.slice(0, MAX_NODES);
    byId = new Map(graph.nodes.map((n) => [n.id, n]));
    adj = new Map(graph.nodes.map((n) => [n.id, { in: [], out: [] }]));
    graph.links = graph.links.filter((l) => byId.has(l.source) && byId.has(l.target));
    for (const l of graph.links) { adj.get(l.source).out.push(l); adj.get(l.target).in.push(l); }
    if (graph.nodes.length <= 1) {
      clear(body).append(empty('The graph fills as you add docs, memories, agents and red lines.', 'npx @finalangel/flowrail-os remember "Releases go out on Tuesdays" --type project --name release-day', ctx));
      return;
    }
    clear(datalist).append(...graph.nodes.slice(0, 400).map((n) => h('option', { value: n.label })));
    const want = ctx.params.get('focus');
    const hub = graph.nodes.find((n) => n.kind === 'hub') || [...graph.nodes].sort((a, b) => adj.get(b.id).in.length + adj.get(b.id).out.length - adj.get(a.id).in.length - adj.get(a.id).out.length)[0];
    focusId = (want && findNode(want)?.id) || hub.id;
    clear(body).append(h('div.graph-wrap', tray, box));
    paintLegend();
    rebuild(true);
    selectNode(want ? focusId : null);
  }
  const findNode = (q) => { const s = q.toLowerCase(); return graph.nodes.find((n) => n.id === q || n.label.toLowerCase() === s || n.label.toLowerCase().replace(/\.md$/, '') === s || (n.path || '').toLowerCase() === s); };

  function paintLegend() {
    const counts = {};
    for (const n of graph.nodes) counts[n.kind] = (counts[n.kind] || 0) + 1;
    clear(legend).append(...KINDS.filter(([k]) => counts[k]).map(([k, label]) => h('label', { style: `--c:var(--k-${k})` },
      h('input', { type: 'checkbox', checked: on.has(k), onchange: (e) => { e.target.checked ? on.add(k) : on.delete(k); rebuild(); } }),
      shapeSvg(k), h('span', label), h('span.n', counts[k]))));
  }

  /* ---------- visible subgraph ---------- */
  function rebuild(first) {
    const ok = (n) => n.kind === 'hub' || on.has(n.kind);
    let ids;
    if (showAll) ids = new Set(graph.nodes.filter(ok).map((n) => n.id));
    else {
      ids = new Set([focusId]);
      let frontier = [focusId];
      for (let depth = 0; depth < 2 && frontier.length; depth++) {
        const next = [];
        for (const id of frontier) for (const l of [...adj.get(id).out, ...adj.get(id).in]) {
          const o = l.source === id ? l.target : l.source;
          if (!ids.has(o) && ok(byId.get(o))) { ids.add(o); next.push(o); }
        }
        frontier = next;
        if (ids.size > 80) break; // one ring is enough for busy hubs
      }
    }
    vis = [...ids].map((id) => byId.get(id));
    visLinks = graph.links.filter((l) => ids.has(l.source) && ids.has(l.target));
    // seed positions near a placed neighbour
    const f = pos.get(focusId) || { x: 0, y: 0 };
    vis.forEach((n, i) => {
      if (pos.has(n.id)) return;
      const nb = [...adj.get(n.id).in, ...adj.get(n.id).out].map((l) => pos.get(l.source === n.id ? l.target : l.source)).find(Boolean) || f;
      const a = i * 2.39996, r = 30 + Math.sqrt(i) * 12;
      pos.set(n.id, { x: nb.x + Math.cos(a) * r, y: nb.y + Math.sin(a) * r, vx: 0, vy: 0 });
    });
    status.textContent = `${vis.length} of ${graph.nodes.length} nodes${showAll ? '' : ' · neighborhood'}`;
    kick(first ? 1 : 0.6, first);
  }

  /* ---------- simulation ---------- */
  function tick() {
    const n = vis.length, P = vis.map((v) => pos.get(v.id));
    const rep = 900 * alpha;
    if (n <= 400) {
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) repel(P[i], P[j], rep);
    } else {
      // Uniform grid cut-off instead of Barnes-Hut; fine up to the 1500-node cap.
      const cell = 90, grid = new Map();
      P.forEach((p) => { const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; (grid.get(key) || grid.set(key, []).get(key)).push(p); });
      for (const [key, list] of grid) {
        const [cx, cy] = key.split(',').map(Number);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const other = grid.get(`${cx + dx},${cy + dy}`); if (!other) continue;
          for (const a of list) for (const b of other) if (a !== b && (dx > 0 || (dx === 0 && dy > 0) || (dx === 0 && dy === 0 && a.x + a.y * 1e-6 < b.x + b.y * 1e-6))) repel(a, b, rep);
        }
      }
    }
    for (const l of visLinks) {
      const a = pos.get(l.source), b = pos.get(l.target);
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const want = l.kind === 'contains' ? 56 : 90;
      const f = ((d - want) / d) * 0.08 * alpha;
      a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
    }
    for (const p of P) {
      p.vx -= p.x * 0.004 * alpha; p.vy -= p.y * 0.004 * alpha;
      if (p.fx != null) { p.x = p.fx; p.y = p.fy; p.vx = p.vy = 0; continue; }
      p.vx *= 0.6; p.vy *= 0.6; p.x += p.vx; p.y += p.vy;
    }
    alpha *= 0.975;
  }
  function repel(a, b, k) {
    let dx = b.x - a.x, dy = b.y - a.y, d2 = dx * dx + dy * dy;
    if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
    if (d2 > 90000) return;
    const f = k / d2;
    a.vx -= dx * f; a.vy -= dy * f; b.vx += dx * f; b.vy += dy * f;
  }
  function kick(a = 0.5, thenFit) {
    alpha = Math.max(alpha, a);
    cancelAnimationFrame(raf);
    if (reduced()) {
      // No animation: settle off-screen in chunks, then draw once.
      const step = () => { const t0 = performance.now(); while (alpha > 0.01 && performance.now() - t0 < 30) tick(); if (alpha > 0.01) raf = requestAnimationFrame(step); else { if (thenFit) fit(); draw(); } };
      step(); return;
    }
    let fitted = !thenFit;
    const loop = () => {
      const t0 = performance.now();
      do tick(); while (alpha > 0.01 && performance.now() - t0 < 8);
      if (!fitted && alpha < 0.3) { fit(); fitted = true; }
      draw();
      if (alpha > 0.01 || drag) raf = requestAnimationFrame(loop);
    };
    if (thenFit) { for (let i = 0; i < 40; i++) tick(); fit(); }
    raf = requestAnimationFrame(loop);
  }

  /* ---------- drawing ---------- */
  const readColors = () => {
    const cs = getComputedStyle(document.documentElement);
    colors = Object.fromEntries(['surface', 'text', 'text-2', 'text-3', 'hairline', 'accent', 'focus', 'k-hub', ...KINDS.map(([k]) => 'k-' + k)].map((v) => [v, cs.getPropertyValue('--' + v).trim()]));
  };
  const radius = (n) => (n.kind === 'hub' ? 10 : n.kind === 'folder' ? 6 : 4 + Math.min(4, Math.sqrt(n.size || 1)));

  function draw() {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hgt * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hgt);
    c.translate(w / 2 + view.x, hgt / 2 + view.y); c.scale(view.k, view.k);
    const near = new Set();
    const hot = selected || hover;
    if (hot) { near.add(hot); for (const l of [...adj.get(hot).in, ...adj.get(hot).out]) { near.add(l.source); near.add(l.target); } }
    c.lineWidth = 1 / view.k;
    for (const l of visLinks) {
      const a = pos.get(l.source), b = pos.get(l.target);
      c.strokeStyle = hot && (l.source === hot || l.target === hot) ? colors['text-3'] : colors.hairline;
      c.setLineDash(l.kind === 'contains' ? [3 / view.k, 3 / view.k] : []);
      c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
    }
    c.setLineDash([]);
    const labelAll = vis.length <= 60 || view.k > 1.6;
    for (const n of vis) {
      const p = pos.get(n.id), r = radius(n);
      c.globalAlpha = hot && !near.has(n.id) ? 0.35 : 1;
      shape(c, SHAPE[n.kind] || 'circle', p.x, p.y, r, colors['k-' + n.kind] || colors['text-2']);
      if (n.id === selected) { c.strokeStyle = colors.focus; c.lineWidth = 2 / view.k; c.beginPath(); c.arc(p.x, p.y, r + 4, 0, Math.PI * 2); c.stroke(); c.lineWidth = 1 / view.k; }
      if (labelAll || near.has(n.id) || n.kind === 'hub') {
        c.font = `${n.kind === 'hub' ? 600 : 400} ${12 / Math.max(view.k, 0.6)}px Geist, system-ui, sans-serif`;
        c.fillStyle = n.kind === 'hub' || n.id === hot ? colors.text : colors['text-2'];
        c.textBaseline = 'middle';
        c.fillText(n.label.length > 28 && n.id !== hot && n.id !== selected ? n.label.slice(0, 27) + '…' : n.label, p.x + r + 5, p.y);
      }
    }
    c.globalAlpha = 1;
  }
  function shape(c, s, x, y, r, col) {
    c.fillStyle = col; c.strokeStyle = col;
    const poly = (k, rot) => { c.beginPath(); for (let i = 0; i < k; i++) { const a = rot + (i * 2 * Math.PI) / k; c[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * r, y + Math.sin(a) * r); } c.closePath(); c.fill(); };
    if (s === 'hub') { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.lineWidth = 1.5 / view.k; c.beginPath(); c.arc(x, y, r + 3, 0, 7); c.stroke(); c.lineWidth = 1 / view.k; }
    else if (s === 'square') { c.beginPath(); c.roundRect ? c.roundRect(x - r, y - r, 2 * r, 2 * r, r / 3) : c.rect(x - r, y - r, 2 * r, 2 * r); c.fill(); }
    else if (s === 'diamond') poly(4, 0);
    else if (s === 'triangle') poly(3, -Math.PI / 2);
    else if (s === 'hexagon') poly(6, Math.PI / 6);
    else if (s === 'pentagon') poly(5, -Math.PI / 2);
    else if (s === 'ring') { c.lineWidth = 2 / view.k; c.beginPath(); c.arc(x, y, r - 1, 0, 7); c.stroke(); c.lineWidth = 1 / view.k; }
    else if (s === 'bars') { c.lineWidth = 2.2 / view.k; c.lineCap = 'round'; c.beginPath(); c.moveTo(x - r / 2, y - r); c.lineTo(x - r / 2, y + r); c.moveTo(x + r / 2, y - r); c.lineTo(x + r / 2, y + r); c.stroke(); c.lineWidth = 1 / view.k; }
    else { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
  }

  /* ---------- view ---------- */
  function fit() {
    if (!vis.length || !canvas.clientWidth) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of vis) { const p = pos.get(n.id); x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    const w = canvas.clientWidth - 120, hh = canvas.clientHeight - 80;
    view.k = Math.max(0.2, Math.min(2, w / Math.max(1, x1 - x0), hh / Math.max(1, y1 - y0)));
    view.x = -((x0 + x1) / 2) * view.k; view.y = -((y0 + y1) / 2) * view.k;
    draw();
  }
  function zoomBy(f, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
    const k = Math.max(0.15, Math.min(4, view.k * f));
    const wx = (cx - canvas.clientWidth / 2 - view.x) / view.k, wy = (cy - canvas.clientHeight / 2 - view.y) / view.k;
    view.k = k; view.x = cx - canvas.clientWidth / 2 - wx * k; view.y = cy - canvas.clientHeight / 2 - wy * k;
    draw();
  }
  const toWorld = (e) => { const r = canvas.getBoundingClientRect(); return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k }; };
  function hit(e) {
    const w = toWorld(e); let best = null, bd = Infinity;
    for (const n of vis) { const p = pos.get(n.id); const d = Math.hypot(p.x - w.x, p.y - w.y); if (d < radius(n) + 6 / view.k && d < bd) { bd = d; best = n; } }
    return best;
  }

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const n = hit(e);
    drag = { n, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false };
    canvas.classList.add('dragging');
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag) { const n = hit(e); const id = n?.id || null; if (id !== hover) { hover = id; canvas.style.cursor = n ? 'pointer' : ''; draw(); } return; }
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    if (!drag.moved) return;
    if (drag.n) { const p = pos.get(drag.n.id), w = toWorld(e); p.fx = w.x; p.fy = w.y; if (alpha < 0.1) kick(0.15); }
    else { view.x = drag.vx + dx; view.y = drag.vy + dy; draw(); }
  });
  const end = () => {
    if (!drag) return;
    if (drag.n) { const p = pos.get(drag.n.id); p.fx = p.fy = null; }
    if (!drag.moved) selectNode(drag.n?.id || null);
    drag = null; canvas.classList.remove('dragging');
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const r = canvas.getBoundingClientRect(); zoomBy(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top); }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const s = 40;
    const m = { ArrowLeft: [s, 0], ArrowRight: [-s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[e.key];
    if (m) { view.x += m[0]; view.y += m[1]; draw(); e.preventDefault(); }
    else if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(0.83);
    else if (e.key === '0') fit();
  });

  /* ---------- selection & detail ---------- */
  const hrefFor = (n) => {
    if (n.kind === 'memory') return '#/memory?q=' + encodeURIComponent(n.label);
    if (n.kind === 'redline') return '#/redlines';
    if (n.kind === 'routine') return '#/routines';
    if (n.kind === 'artifact') return '#/artifacts';
    if (n.kind === 'folder' || n.kind === 'hub') return null;
    return n.path ? '#/docs?path=' + encodeURIComponent(n.path) : null;
  };
  function focusOn(id) { focusId = id; selected = id; if (!showAll) rebuild(); selectNode(id); }
  function selectNode(id) {
    selected = id; draw();
    clear(detail);
    const n = id && byId.get(id);
    if (!n) { detail.append(h('p.meta', 'Click a node to see what links to it.')); return; }
    const linkBtn = (l, dir) => { const o = byId.get(dir === 'in' ? l.source : l.target); return o && h('li', h('button.item', { type: 'button', style: 'min-height:36px;padding:6px', onclick: () => focusOn(o.id) }, shapeSvg(o.kind), h('span.grow', h('span.t', o.label)), h('span.when', l.kind === 'contains' ? '' : l.kind))); };
    const ins = adj.get(id).in, outs = adj.get(id).out;
    const href = hrefFor(n);
    detail.append(
      h('div.row', { style: `--c:var(--k-${n.kind});color:var(--c)` }, shapeSvg(n.kind), h('span.meta', KINDS.find(([k]) => k === n.kind)?.[1]?.replace(/s$/, '') || n.kind)),
      h('h2', { style: 'margin-top:6px;overflow-wrap:anywhere' }, n.label),
      n.path && h('p.meta.mono', { style: 'overflow-wrap:anywhere;font-size:12px' }, n.path),
      h('div.row', { style: 'margin-top:10px' }, href && h('a.btn.sm', { href }, 'Open'), id !== focusId && h('button.btn.sm', { type: 'button', onclick: () => focusOn(id) }, 'Focus here')),
      ins.length ? h('div', { style: 'margin-top:12px' }, h('div.label', `Backlinks (${ins.length})`), h('ul.list', ins.slice(0, 30).map((l) => linkBtn(l, 'in')))) : h('p.meta', { style: 'margin-top:12px' }, 'No backlinks.'),
      outs.length ? h('div', { style: 'margin-top:12px' }, h('div.label', `Links to (${outs.length})`), h('ul.list', outs.slice(0, 30).map((l) => linkBtn(l, 'out')))) : null);
  }

  const ro = new ResizeObserver(() => draw());
  const onTheme = () => { readColors(); draw(); };
  readColors();
  window.addEventListener('flowrail:theme', onTheme);
  load().then(() => box.isConnected && ro.observe(box));

  const unmount = () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('flowrail:theme', onTheme); };
  unmount.update = (params) => { const f = params.get('focus'); const n = f && graph && findNode(f); if (n) focusOn(n.id); };
  return unmount;
}
