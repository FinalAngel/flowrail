// Icons from files (a link's or an artifact sidecar's "svg"): stroke-only shapes on a 24px grid.
// The markup never reaches the page. It is parsed into a list of { tag, attrs } that keeps only the
// shape elements and geometric attributes below, with values that are numbers or path data, and the
// page builds the elements itself. Anything else (script, foreignObject, on*, href, style, entities,
// url(...)) is dropped.
const TAGS = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'ellipse']);
const NUM = new Set(['cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height']);
const NUM_RE = /^-?\d*\.?\d+$/;
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]+$/;
const POINTS_RE = /^[\d\s.,eE+-]+$/;
const MAX_SHAPES = 24;
const MAX_LEN = 4000;

/** Shapes from untrusted SVG markup: [{ tag, attrs }], empty when nothing safe is left. */
export function svgShapes(markup) {
  if (typeof markup !== 'string' || markup.length > MAX_LEN || markup.includes('&')) return [];
  const out = [];
  for (const m of markup.matchAll(/<\s*([a-zA-Z][\w:-]*)([^<>]*?)\/?\s*>/g)) {
    const tag = m[1].toLowerCase();
    if (!TAGS.has(tag)) continue;
    const attrs = {};
    for (const a of m[2].matchAll(/([a-zA-Z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = a[1].toLowerCase();
      const value = (a[2] ?? a[3]).trim();
      if (NUM.has(name) && NUM_RE.test(value)) attrs[name] = value;
      else if (name === 'd' && tag === 'path' && PATH_RE.test(value)) attrs.d = value;
      else if (name === 'points' && (tag === 'polyline' || tag === 'polygon') && POINTS_RE.test(value)) attrs.points = value;
    }
    if (Object.keys(attrs).length) out.push({ tag, attrs });
    if (out.length >= MAX_SHAPES) break;
  }
  return out;
}
