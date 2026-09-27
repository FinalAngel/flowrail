// Rings: the repo drawn as concentric rings around CLAUDE.md. From the centre out, on one unit U:
//   hub -1- skills and commands -1- area markers -1- documents (a band two units deep, one sector
//   per area) -1- routines and red lines -1- artifacts
// Spokes run from the centre to each area's marker and from the marker to its entries; the outer
// rings draw each entry as a badge with its glyph and its age.
// Every radius comes from U, so the rhythm holds at any size. Points glow from a cached sprite per
// colour (no shadowBlur), links share one ink and take the area colour on hover, a folder with many
// documents is one larger star carrying its count. The canvas paints no background and never takes
// the wheel, so the page scrolls over it. Keyboard and screen readers get the same items as a list.
import { h, clear, skeleton, errorBox, empty } from '../lib/dom.js';
import { iconPath } from '../icons.js';

const FOLD = 4;          // a folder with more documents than this in one area is drawn as one star
const CORE = 0.3;        // where the sprite's solid core ends, as a share of its radius
const BIG = 72;          // a point wider than this on screen is filled flat (the halo would smear)
const AREA_COLORS = 8;   // --area-1 … --area-8
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t) => 1 - (1 - t) ** 3;

export function rings(el, ctx) {
  let graph = null, items = [], base = [], links = [], byId = new Map(), areas = [];
  let colors = {}, hover = null, settled = false, t0 = 0, raf = 0, U = 0, cx = 0, cy = 0;
  const sprites = new Map();

  const canvas = h('canvas', { 'aria-hidden': 'true' });
  const tip = h('div.rings-tip', { hidden: true });
  const box = h('div.rings-box', canvas, tip);
  const legend = h('div.rings-legend', { role: 'list', 'aria-label': 'Areas' });
  const list = h('nav.sr-only.rings-list', { 'aria-label': 'Everything on the map' });
  const body = h('div', skeleton(6));
  el.append(body);

  /* ---------- data and layout ---------- */
  async function load() {
    try { graph = await ctx.api('/graph'); } catch (e) { clear(body).append(errorBox(e, load)); return; }
    areas = graph.areas || [];
    if (graph.nodes.length <= 1) {
      clear(body).append(empty('The map fills as you add docs, skills, routines and artifacts.', 'npx @finalangel/flowrail-room remember "Releases go out on Tuesdays" --type project --name release-day', ctx));
      return;
    }
    build();
    clear(body).append(box, legend, list);
    paintLegend();
    paintList();
    readColors();
    resize();
    ro.observe(box);
    t0 = performance.now();
    settled = reduced();
    raf = requestAnimationFrame(frame);
  }

  function build() {
    const n = graph.nodes;
    const hub = n.find((x) => x.kind === 'hub');
    // Everything but the band's documents: placed on its rings in layout(), never folded.
    base = [{ ...hub, ring: 'hub' }];
    for (const r of ['skill', 'routine', 'artifact']) base.push(...n.filter((x) => x.ring === r).map((x) => ({ ...x })));
    // The band's documents by area; how many fold into folder stars is decided in layout(), where
    // each area's room is known.
    const docs = n.filter((x) => x.ring === 'band' && x.kind !== 'folder');
    const groups = new Map();
    for (const d of docs) {
      const a = d.area ?? -1;
      if (!groups.has(a)) groups.set(a, []);
      groups.get(a).push({ ...d, area: a });
    }
    items = [];
    items.sectors = [...groups].sort((x, y) => (x[0] === -1) - (y[0] === -1) || x[0] - y[0]).map(([area, list]) => ({ area, docs: list, items: [] }));
    fold(Infinity);
  }

  const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
  const cut = (dir, depth) => dir.split('/').slice(0, depth).join('/');

  /** One area's band items: its documents, with folders folded into stars until they fit `cap`. */
  function foldArea(s, cap) {
    const deepest = Math.max(1, ...s.docs.map((d) => dirOf(d.path).split('/').length));
    // Fold big folders, then any folder with two or more, then by ever shallower parent folders.
    const steps = [[Infinity, FOLD + 1], [Infinity, 2]];
    for (let d = deepest - 1; d >= 1; d--) steps.push([d, 2]);
    let out = [];
    for (const [depth, min] of steps) {
      const byDir = new Map();
      for (const d of s.docs) { const k = cut(dirOf(d.path), depth); if (!byDir.has(k)) byDir.set(k, []); byDir.get(k).push(d); }
      out = [];
      for (const [dir, list] of [...byDir].sort((x, y) => x[0].localeCompare(y[0]))) {
        if (dir && list.length >= min) out.push({ id: `fold:${s.area}:${dir}`, kind: 'folder', label: dir.split('/').pop() + '/', path: dir, count: list.length, area: s.area, members: new Set(list.map((d) => d.id)) });
        else out.push(...list);
      }
      if (out.length <= cap) break;
    }
    return out;
  }

  /** Rebuild the band's items at the given room per area, then the lookup and the links. */
  function fold(capOf) {
    for (const s of items.sectors) s.items = foldArea(s, typeof capOf === 'function' ? capOf(s) : capOf);
    items.splice(0, items.length, ...base, ...items.sectors.flatMap((s) => s.items.map((x) => ({ ...x, ring: 'band' }))));
    byId = new Map(items.map((x) => [x.id, x]));
    // A link into a folded document points at its folder's star.
    const folded = new Map();
    for (const x of items) if (x.members) for (const m of x.members) folded.set(m, x.id);
    const at = (id) => (byId.has(id) ? id : folded.get(id));
    const seen = new Set();
    links = [];
    for (const l of graph.links) {
      if (l.kind === 'contains' || l.kind === 'module') continue;
      const a = at(l.source), b = at(l.target);
      if (!a || !b || a === b || seen.has(a + '>' + b)) continue;
      seen.add(a + '>' + b);
      links.push({ s: a, t: b });
    }
  }

  /**
   * Target positions from the one unit U. An entry gets U/3 of arc (the pitch); a ring with more
   * than one row's worth adds rows around its radius, and the two-unit band adds rows inside it.
   * The area that needs the most rows sets them for every area, so the rows line up.
   */
  function layout() {
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    cx = w / 2; cy = hh / 2;
    U = Math.max(10, (Math.min(w, hh) / 2 - 18) / 7.4);
    const R = { skill: U, area: 2 * U, band0: 3 * U, band1: 5 * U, routine: 6 * U, artifact: 7 * U };
    const pitch = U / 3;
    items.pitch = pitch;
    const TAU = 2 * Math.PI;
    // outward: extra rows grow away from the centre (the skills ring, so the hub's name stays clear).
    const ring = (list, r, phase, outward = false) => {
      const perRow = Math.max(1, Math.floor((TAU * r) / pitch));
      const rows = Math.max(1, Math.min(3, Math.ceil(list.length / perRow)));
      const per = Math.ceil(list.length / rows);
      list.rows = rows;
      list.gap = list.length ? (TAU * r) / per : 0;
      list.forEach((x, i) => {
        const row = Math.floor(i / per), k = i % per, n = Math.min(per, list.length - row * per);
        x.r = r + (outward ? row : row - (rows - 1) / 2) * pitch;
        x.a = phase + ((k + (row % 2) * 0.5) / n) * TAU;
      });
    };
    // Sectors: room by the square root of the documents, never less than the area's name needs,
    // with a gap between areas.
    const sec = items.sectors, gap = sec.length > 1 ? 0.05 : 0, rl = R.area + U * 0.42;
    const c = canvas.getContext('2d');
    c.font = '500 11px Geist, system-ui, sans-serif';
    const minSpan = sec.map((s) => (s.area < 0 ? 0.05 : (c.measureText(areas[s.area]?.name || '').width + 18) / rl));
    const want = sec.map((s) => Math.sqrt(Math.max(1, s.docs.length)));
    const free = TAU - gap * sec.length;
    let spans = want.map((x) => (x / want.reduce((a, b) => a + b, 0)) * free);
    // Lift the small ones to their minimum and take it from the rest, in proportion.
    for (let pass = 0; pass < 4; pass++) {
      const short = spans.map((x, i) => Math.max(0, minSpan[i] - x));
      const need = short.reduce((a, b) => a + b, 0);
      if (need < 1e-6) break;
      const spare = spans.map((x, i) => (short[i] ? 0 : Math.max(0, x - minSpan[i])));
      const pool = spare.reduce((a, b) => a + b, 0);
      if (pool <= need) break;
      spans = spans.map((x, i) => (short[i] ? minSpan[i] : x - (spare[i] / pool) * need));
    }
    const depth = R.band1 - R.band0, maxRows = Math.max(1, Math.floor(depth / pitch));
    sec.forEach((s, i) => { s.span = spans[i]; s.perRow = Math.max(1, Math.floor((spans[i] * R.band0) / pitch)); });
    fold((s) => s.perRow * maxRows);
    const rows = Math.min(maxRows, Math.max(1, ...sec.map((s) => Math.ceil(s.items.length / s.perRow))));
    const rowR = (row) => R.band0 + (row + 0.5) * (depth / rows);
    let a0 = -Math.PI / 2;
    sec.forEach((s) => {
      s.a0 = a0; s.a1 = a0 + s.span; s.mid = a0 + s.span / 2;
      const per = Math.max(1, Math.ceil(s.items.length / rows));
      s.items.forEach((x, j) => {
        const row = Math.floor(j / per), k = j % per, n = Math.min(per, s.items.length - row * per);
        const it = byId.get(x.id);
        it.r = rowR(row);
        it.a = a0 + s.span * ((k + 0.5 + (row % 2 ? 0.25 : 0)) / (n + 0.5));
      });
      a0 += s.span + gap;
    });
    const hub = items[0]; hub.a = 0; hub.r = 0;
    ring(items.filter((x) => x.ring === 'skill'), R.skill, -Math.PI / 2, true);
    // The outer rings are badges: as large as their spacing allows, capped, with an age label
    // under each while the ring is a single row.
    for (const [key, phase] of [['routine', 0.2], ['artifact', 0.1]]) {
      const list = items.filter((x) => x.ring === key);
      ring(list, R[key], -Math.PI / 2 + phase);
      const br = Math.max(3, Math.min(U * 0.28, list.gap * (list.rows > 1 ? 0.3 : 0.4)));
      for (const x of list) { x.badge = br; x.aged = list.rows === 1 && br >= 7; }
    }
    // Area markers are hoverable too: hovering one lights its fan of spokes.
    items.markers = sec.filter((s) => s.area >= 0).map((s) => ({ id: `area:${s.area}`, kind: 'area', ring: 'area', a: s.mid, r: R.area, area: s.area, label: areas[s.area]?.name || '', sector: s }));
    for (const m of items.markers) byId.set(m.id, m);
    items.R = R;
    items.labelR = rl;
  }

  /* ---------- colour and sprites ---------- */
  const probe = document.createElement('canvas').getContext('2d');
  const rgb = (c) => { probe.fillStyle = '#000'; probe.fillStyle = c; const v = probe.fillStyle; if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)); return v.match(/[\d.]+/g).slice(0, 3).map(Number); };
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue('--' + n).trim();
    colors = { surface: v('surface'), text: v('text'), text2: v('text-2'), text3: v('text-3'), hairline: v('hairline'), hub: v('k-hub'), skill: v('k-skill'), agent: v('k-agent'), routine: v('k-routine'), redline: v('k-redline'), artifact: v('k-artifact') || v('info'), other: v('k-folder'), areas: Array.from({ length: AREA_COLORS }, (_, i) => v(`area-${i + 1}`)) };
    sprites.clear();
  }
  const areaColor = (a) => (a == null || a < 0 ? colors.other : colors.areas[a % AREA_COLORS]);
  const colorOf = (x) => (x.ring === 'band' ? areaColor(x.area) : colors[x.kind] || colors.text2);
  function sprite(color) {
    let s = sprites.get(color);
    if (s) return s;
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), [r, gr, b] = rgb(color);
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, `rgba(${r},${gr},${b},1)`);
    grd.addColorStop(CORE, `rgba(${r},${gr},${b},1)`);
    grd.addColorStop(CORE + 0.06, `rgba(${r},${gr},${b},.32)`);
    grd.addColorStop(0.62, `rgba(${r},${gr},${b},.08)`);
    grd.addColorStop(1, `rgba(${r},${gr},${b},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    sprites.set(color, c);
    return c;
  }
  // Stars grow with their count but stay inside their own slot, so neighbours never touch.
  const size = (x) => {
    const slot = (items.pitch || U / 3) * 0.48;
    if (x.kind === 'hub') return U * 0.34;
    if (x.kind === 'area') return Math.min(U * 0.16, 5);
    if (x.badge) return x.badge;
    if (x.kind === 'folder') return Math.min(slot, 2.5 + Math.sqrt(x.count) * 1.4);
    return Math.min(slot * 0.62, x.ring === 'band' ? 4.2 : 3.6);
  };
  const GLYPH = { routine: 'routines', redline: 'redlines', artifact: 'docs' };
  const glyphs = new Map();
  /** An outer-ring entry: a tinted disc, a ring in its colour and its glyph stroked on top. */
  function badge(c, x, y, r, color, kind) {
    c.fillStyle = colors.surface; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.fillStyle = color;
    const a = c.globalAlpha; c.globalAlpha = a * 0.16; c.fill(); c.globalAlpha = a;
    c.strokeStyle = color; c.lineWidth = Math.max(1, r / 7); c.stroke();
    if (r < 6) return;
    const name = GLYPH[kind] || 'docs';
    if (!glyphs.has(name)) glyphs.set(name, iconPath(name));
    const s = (r * 1.15) / 24;
    c.save(); c.translate(x - 12 * s, y - 12 * s); c.scale(s, s);
    c.lineWidth = 1.8; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = color; c.stroke(glyphs.get(name));
    c.restore();
  }
  const age = (at) => {
    const d = (Date.now() - Date.parse(at)) / 3600000;
    if (!(d >= 0)) return '';
    return d < 1 ? 'now' : d < 24 ? `${Math.floor(d)}h` : d < 24 * 14 ? `${Math.floor(d / 24)}d` : `${Math.floor(d / 168)}w`;
  };
  function point(c, x, y, r, color) {
    if (r * 2 / CORE > BIG) { c.fillStyle = color; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); return; }
    const R = r / CORE;
    c.drawImage(sprite(color), x - R, y - R, 2 * R, 2 * R);
  }

  /* ---------- drawing ---------- */
  const xy = (x, k = 1) => [cx + Math.cos(x.a) * x.r * k, cy + Math.sin(x.a) * x.r * k];
  function frame(now) {
    const t = settled ? 1 : Math.min(1, (now - t0) / 700);
    draw(t);
    if (t < 1) raf = requestAnimationFrame(frame);
    else settled = true;
  }
  function draw(t = 1) {
    const dpr = devicePixelRatio || 1, w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w || !U) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(hh * dpr); }
    const c = canvas.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, hh);
    const k = (x) => ease(Math.max(0, Math.min(1, t * 1.25 - (x.r / (7 * U)) * 0.25)));
    const R = items.R;
    // The ring guides, faint.
    c.strokeStyle = colors.hairline; c.lineWidth = 1;
    for (const r of [R.skill, R.area, R.routine, R.artifact]) { c.beginPath(); c.arc(cx, cy, r * ease(t), 0, 7); c.stroke(); }
    const TAU = 2 * Math.PI;
    c.beginPath(); c.arc(cx, cy, R.band1 * ease(t), 0, TAU); c.moveTo(cx + R.band0 * ease(t), cy); c.arc(cx, cy, R.band0 * ease(t), TAU, 0, true);
    c.fillStyle = colors.hairline; c.globalAlpha = 0.28; c.fill('evenodd');
    c.globalAlpha = 1;
    const hot = hover && byId.get(hover);
    // Spokes: centre to each area marker, marker to each of its entries. One faint ink, thinner the
    // more entries a fan has; the hovered fan (its marker, or one of its entries) in the area colour.
    const fanOf = hot ? (hot.kind === 'area' ? hot.area : hot.ring === 'band' ? hot.area : null) : null;
    // Hovering the centre lights its spoke to every department, each in its own colour.
    const hubHot = hot?.kind === 'hub';
    for (const m of items.markers) {
      const [mx, my] = xy(m, ease(t));
      const lit = fanOf === m.area;
      c.strokeStyle = lit || hubHot ? areaColor(m.area) : colors.text3;
      c.lineWidth = lit || hubHot ? 1.6 : 1;
      c.globalAlpha = lit || hubHot ? 0.85 : hot ? 0.08 : 0.3;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(mx, my); c.stroke();
      const fan = m.sector.items;
      const base = Math.min(0.2, 1.6 / Math.sqrt(Math.max(1, fan.length)));
      c.lineWidth = lit ? 1 : 0.8;
      for (const e of fan) {
        const x = byId.get(e.id);
        if (!x) continue;
        const one = hot && hot.id === x.id;
        if (hot && !lit) continue;
        c.globalAlpha = one ? 0.95 : lit ? Math.max(0.25, base * 3) : base;
        const [px, py] = xy(x, k(x));
        c.beginPath(); c.moveTo(mx, my); c.lineTo(px, py); c.stroke();
      }
    }
    c.globalAlpha = 1;
    // Links: one ink; the hovered node's links in its colour.
    c.lineWidth = 1;
    for (const l of links) {
      const a = byId.get(l.s), b = byId.get(l.t);
      const lit = hot && (l.s === hover || l.t === hover);
      if (hot && !lit) continue;
      const [x1, y1] = xy(a, k(a)), [x2, y2] = xy(b, k(b));
      c.strokeStyle = lit ? colorOf(hot) : colors.text3;
      c.globalAlpha = lit ? 0.9 : 0.14;
      c.beginPath(); c.moveTo(x1, y1); c.quadraticCurveTo((x1 + x2) / 2 * 0.6 + cx * 0.4, (y1 + y2) / 2 * 0.6 + cy * 0.4, x2, y2); c.stroke();
    }
    c.globalAlpha = 1;
    // Area markers and their names along the arc.
    for (const m of items.markers) {
      const [x, y] = xy(m, ease(t));
      c.globalAlpha = hot && !hubHot && fanOf !== m.area ? 0.4 : 1;
      point(c, x, y, size(m), areaColor(m.area));
      if (t === 1) arcLabel(c, m.label, m.sector, items.labelR, areaColor(m.area));
    }
    c.globalAlpha = 1;
    const near = new Set();
    if (hot) { near.add(hover); near.add(items[0].id); for (const l of links) { if (l.s === hover) near.add(l.t); if (l.t === hover) near.add(l.s); } }
    if (hot?.kind === 'area') for (const e of hot.sector.items) near.add(e.id);
    for (const x of items) {
      const [px, py] = xy(x, k(x));
      c.globalAlpha = hot && !near.has(x.id) ? 0.3 : 1;
      const r = size(x);
      if (x.badge) {
        badge(c, px, py, r, colorOf(x), x.kind);
        if (x.aged && x.at && t === 1) {
          const label = age(x.at);
          if (label) { c.font = '500 9.5px Geist Mono, ui-monospace, monospace'; c.fillStyle = colors.text3; c.textAlign = 'center'; c.textBaseline = 'top'; c.fillText(label, px, py + r + 4); }
        }
        continue;
      }
      point(c, px, py, r, x.kind === 'hub' ? colors.hub : colorOf(x));
      if (x.kind === 'folder' && r >= 6 && t === 1) {
        c.fillStyle = colors.surface;
        const label = x.count > 999 ? `${Math.round(x.count / 100) / 10}k` : String(x.count);
        c.font = `600 ${Math.min(r * 1.05, Math.max(7, (r * 2.2) / Math.max(1, label.length * 0.62)))}px Geist, system-ui, sans-serif`;
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(label, px, py + 0.5);
      }
    }
    c.globalAlpha = 1;
    if (t === 1) {
      const hubLabel = items[0].label;
      c.font = '600 12px Geist, system-ui, sans-serif'; c.fillStyle = colors.text; c.textAlign = 'center'; c.textBaseline = 'top';
      // A backing in the page colour keeps the name readable over the skills ring.
      const ly = cy + size(items[0]) + 6, lw = c.measureText(hubLabel).width + 12;
      c.globalAlpha = 0.85; c.fillStyle = colors.surface;
      c.beginPath(); c.roundRect(cx - lw / 2, ly - 3, lw, 20, 10); c.fill();
      c.globalAlpha = 1; c.fillStyle = colors.text;
      c.fillText(hubLabel, cx, ly);
    }
    if (hot) { c.strokeStyle = colors.text; c.lineWidth = 1.5; const [px, py] = xy(hot); c.beginPath(); c.arc(px, py, size(hot) + 4, 0, 7); c.stroke(); }
  }

  /** A name set glyph by glyph along its sector's arc; flat when the arc is too short to read it. */
  function arcLabel(c, text, s, r, color) {
    c.font = '500 11px Geist, system-ui, sans-serif';
    c.fillStyle = color;
    const width = c.measureText(text).width;
    const span = (s.a1 - s.a0) * r;
    const mid = ((s.mid % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (width > span * 0.9 || width < 1) {
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(text.length > 14 ? text.slice(0, 13) + '…' : text, cx + Math.cos(s.mid) * r, cy + Math.sin(s.mid) * r);
      return;
    }
    const bottom = mid > 0 && mid < Math.PI; // read left to right on the lower half too
    let a = s.mid + (bottom ? 1 : -1) * (width / 2) / r;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    for (const ch of text) {
      const cw = c.measureText(ch).width;
      a += (bottom ? -1 : 1) * (cw / 2) / r;
      c.save();
      c.translate(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      c.rotate(a + (bottom ? -Math.PI / 2 : Math.PI / 2));
      c.fillText(ch, 0, 0);
      c.restore();
      a += (bottom ? -1 : 1) * (cw / 2) / r;
    }
  }

  /* ---------- interaction (after the map has settled) ---------- */
  const hrefFor = (x) => {
    if (x.kind === 'hub') return x.path ? '#/docs?path=' + encodeURIComponent(x.path) : null;
    if (x.kind === 'area') return areas[x.area]?.router ? '#/docs?path=' + encodeURIComponent(areas[x.area].router) : null;
    if (x.kind === 'folder') return '#/knowledge?view=tree&path=' + encodeURIComponent(x.path);
    if (x.kind === 'memory') return '#/memory?q=' + encodeURIComponent(x.label);
    if (x.kind === 'routine') return '#/routines';
    if (x.kind === 'redline') return '#/redlines';
    if (x.kind === 'artifact') return '#/artifacts';
    return x.path ? '#/docs?path=' + encodeURIComponent(x.path) : null;
  };
  const describe = (x) => {
    if (x.kind === 'area') return `${x.label} · ${x.sector.docs.length} documents`;
    const where = x.ring === 'band' ? (x.area >= 0 ? areas[x.area]?.name : 'No area') : { hub: 'CLAUDE.md', skill: x.kind === 'agent' ? 'Agent' : 'Skill', routine: x.kind === 'redline' ? 'Red line' : 'Routine', artifact: 'Artifact' }[x.ring];
    return x.kind === 'folder' ? `${x.label} · ${x.count} documents · ${where}` : `${x.label} · ${where}`;
  };
  function hit(e) {
    const r = canvas.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = null, bd = Infinity;
    for (const x of [...items, ...(items.markers || [])]) { const [px, py] = xy(x); const d = Math.hypot(px - mx, py - my); if (d < Math.max(size(x) + 5, 8) && d < bd) { bd = d; best = x; } }
    return best;
  }
  function setHover(x) {
    const id = x?.id || null;
    if (id !== hover) { hover = id; draw(); }
    canvas.style.cursor = x && hrefFor(x) ? 'pointer' : '';
    if (!x) { tip.hidden = true; return; }
    tip.textContent = describe(x);
    tip.hidden = false;
    const [px, py] = xy(x);
    tip.style.left = Math.min(canvas.clientWidth - 12, Math.max(12, px)) + 'px';
    tip.style.top = (py - size(x) - 10) + 'px';
  }
  canvas.addEventListener('pointermove', (e) => { if (settled) setHover(hit(e)); });
  canvas.addEventListener('pointerleave', () => setHover(null));
  canvas.addEventListener('click', (e) => { if (!settled) return; const x = hit(e); const href = x && hrefFor(x); if (href) ctx.navigate(href); });

  function paintLegend() {
    const used = new Set(items.filter((x) => x.ring === 'band').map((x) => x.area));
    clear(legend).append(...[
      ...areas.map((a, i) => used.has(i) && h('span.rl', { role: 'listitem', style: `--c:var(--area-${(i % AREA_COLORS) + 1})` }, h('i'), a.name)),
      used.has(-1) && h('span.rl', { role: 'listitem', style: '--c:var(--k-folder)' }, h('i'), 'No area'),
      !areas.length && h('span.meta', 'Name your areas in flowrail/config.json ("areas": [{ "name", "router" }]) or in a table in CLAUDE.md, and documents group by them.')].filter(Boolean));
  }
  function paintList() {
    const group = (title, xs) => xs.length && h('section', h('h2', title), h('ul', xs.map((x) => {
      const href = hrefFor(x);
      return h('li', href ? h('a', { href, onfocus: () => setHover(x), onblur: () => setHover(null) }, describe(x)) : describe(x));
    })));
    clear(list).append(
      group('Centre', items.filter((x) => x.ring === 'hub')),
      group('Skills and agents', items.filter((x) => x.ring === 'skill')),
      ...items.sectors.map((s) => group(s.area >= 0 ? `Area: ${areas[s.area]?.name}` : 'No area', s.items.map((x) => byId.get(x.id)))),
      group('Routines and red lines', items.filter((x) => x.ring === 'routine')),
      group('Artifacts', items.filter((x) => x.ring === 'artifact')));
  }

  function resize() {
    const w = box.clientWidth;
    canvas.style.height = Math.round(Math.min(w, Math.max(360, innerHeight - 200))) + 'px';
    layout();
    paintList(); // folding depends on the room, so the list follows the layout
    draw(settled ? 1 : 0);
  }
  const ro = new ResizeObserver(() => { if (items.length) resize(); });
  const onTheme = () => { readColors(); draw(); };
  window.addEventListener('flowrail:theme', onTheme);
  load();
  return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('flowrail:theme', onTheme); };
}
