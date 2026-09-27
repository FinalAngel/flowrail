// Small, safe Markdown renderer. Every piece of source text is escaped before it reaches the output;
// the only tags emitted are the fixed ones below. Links allow http(s), mailto and relative paths only.

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Resolve a relative link against the current doc path. */
export function resolvePath(base, rel) {
  const parts = base ? base.split('/').slice(0, -1) : [];
  for (const seg of rel.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

function linkHref(url, opts) {
  const u = url.trim();
  if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return { href: u, external: true };
  if (/^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('//')) return null; // javascript:, data:, protocol-relative...
  if (u.startsWith('#/')) return { href: u };
  if (u.startsWith('#')) return null; // in-page anchors do not survive a hash router
  const path = resolvePath(u.startsWith('/') ? '' : opts.base || '', u.replace(/^\//, '').split('#')[0].split('?')[0]);
  return { href: '#/docs?path=' + encodeURIComponent(path) };
}

function emph(s) {
  return s
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
    .replace(/__(?=\S)(.+?)(?<=\S)__/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*(?=\S)(.+?)(?<=\S)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/(^|[^\w])_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<del>$1</del>');
}

/** Inline Markdown to safe HTML. */
export function inline(src, opts = {}) {
  let out = '';
  const re = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[\[([^\]|]+)(?:\|([^\]]+))?\]\]|<(https?:\/\/[^>\s]+)>/g;
  let last = 0, m;
  while ((m = re.exec(src))) {
    out += emph(esc(src.slice(last, m.index)));
    last = re.lastIndex;
    if (m[1]) out += `<code>${esc(m[2].trim())}</code>`;
    else if (m[4] !== undefined) {
      const l = linkHref(m[4], opts);
      const text = emph(esc(m[3] || m[4]));
      out += l ? `<a href="${esc(l.href)}"${l.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>` : text;
    } else if (m[5]) {
      const target = m[5].trim();
      const href = opts.wikiHref ? opts.wikiHref(target) : '#/knowledge?focus=' + encodeURIComponent(target);
      out += `<a class="wikilink" href="${esc(href)}">${esc(m[6] || target)}</a>`;
    } else if (m[7]) out += `<a href="${esc(m[7])}" target="_blank" rel="noopener noreferrer">${esc(m[7])}</a>`;
  }
  return out + emph(esc(src.slice(last)));
}

const RE = {
  fence: /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)/,
  heading: /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?/,
  list: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/,
  comment: /^\s*<!--/,
};

const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const isBlockStart = (l, next) => RE.fence.test(l) || RE.heading.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.list.test(l) || RE.comment.test(l) || (l.includes('|') && next !== undefined && RE.tableSep.test(next));

function renderList(items, opts) {
  // items: [{indent, ordered, text}] ; nest by indent
  let html = '', i = 0;
  const base = items[0].indent;
  const ordered = items[0].ordered;
  html += ordered ? '<ol>' : '<ul>';
  while (i < items.length) {
    const it = items[i++];
    const kids = [];
    while (i < items.length && items[i].indent > base) kids.push(items[i++]);
    const task = /^\[( |x|X)\]\s+/.exec(it.text);
    const body = task ? it.text.slice(task[0].length) : it.text;
    html += task
      ? `<li class="task"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''} aria-label="${task[1] !== ' ' ? 'done' : 'not done'}"> ${inline(body, opts)}`
      : `<li>${inline(body, opts)}`;
    if (kids.length) html += renderList(kids, opts);
    html += '</li>';
  }
  return html + (ordered ? '</ol>' : '</ul>');
}

/** Block Markdown to safe HTML. opts: { base: current doc path, wikiHref(name) } */
export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0, html = '';
  // frontmatter
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end > 0) {
      const rows = lines.slice(1, end).map((l) => /^([\w-]+):\s*(.*)$/.exec(l)).filter(Boolean);
      if (rows.length) html += `<dl class="frontmatter">${rows.map((r) => `<dt>${esc(r[1])}</dt><dd>${esc(r[2])}</dd>`).join('')}</dl>`;
      i = end + 1;
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    let m;
    if ((m = RE.fence.exec(line))) {
      const fence = m[1], buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      html += `<pre><code${m[2] ? ` data-lang="${esc(m[2])}"` : ''}>${esc(buf.join('\n'))}</code></pre>`;
    } else if (RE.comment.test(line)) {
      while (i < lines.length && !lines[i].includes('-->')) i++;
      i++;
    } else if ((m = RE.heading.exec(line))) {
      const n = m[1].length;
      html += `<h${n}>${inline(m[2], opts)}</h${n}>`; i++;
    } else if (RE.hr.test(line)) { html += '<hr>'; i++; }
    else if (RE.quote.test(line)) {
      const buf = [];
      while (i < lines.length && lines[i].trim() && RE.quote.test(lines[i])) buf.push(lines[i++].replace(RE.quote, ''));
      html += `<blockquote>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`;
    } else if (line.includes('|') && RE.tableSep.test(lines[i + 1] || '')) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      const td = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ''}>${inline(c, opts)}</${tag}>`;
      html += `<div class="table-wrap"><table><thead><tr>${head.map((c, j) => td('th', c, j)).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, j) => td('td', r[j] ?? '', j)).join('')}</tr>`).join('')}</tbody></table></div>`;
    } else if (RE.list.test(line)) {
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if ((m = RE.list.exec(l))) { items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: m[3] }); i++; }
        else if (l.trim() && /^\s{2,}/.test(l) && items.length) { items[items.length - 1].text += ' ' + l.trim(); i++; }
        else if (!l.trim() && RE.list.test(lines[i + 1] || '')) i++;
        else break;
      }
      html += renderList(items, opts);
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !(buf.length && isBlockStart(lines[i], lines[i + 1]))) buf.push(lines[i++].trim());
      html += `<p>${buf.map((l) => inline(l, opts)).join(" ")}</p>`;
    }
  }
  return html;
}
