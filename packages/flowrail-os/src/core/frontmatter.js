// Tiny YAML-subset frontmatter parser: `key: value`, quoted strings, [a, b] and "- item" lists.
// Not YAML. Nested maps and multi-line strings are ignored; add a real parser if a file needs them.

export function parseFrontmatter(text) {
  const src = String(text).replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  let listKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const item = /^\s+-\s+(.*)$/.exec(line) || (listKey && /^-\s+(.*)$/.exec(line));
    if (item && listKey) { data[listKey].push(scalar(item[1])); continue; }
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (value === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = value.startsWith('[') && value.endsWith(']')
      ? value.slice(1, -1).split(',').map((s) => scalar(s.trim())).filter((s) => s !== '')
      : scalar(value);
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && !data[k].length && !m[1].includes(`${k}: []`)) data[k] = '';
  return { data, body: src.slice(m[0].length) };
}

function scalar(v) {
  v = v.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export function stringifyFrontmatter(data) {
  const lines = Object.entries(data).map(([k, v]) => {
    const s = String(v ?? '');
    return `${k}: ${/[:#\n"']|^\s|\s$/.test(s) ? JSON.stringify(s) : s}`;
  });
  return `---\n${lines.join('\n')}\n---\n`;
}

/** [[wikilinks]] in a body. */
export function wikilinks(body) {
  return [...String(body).matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
}
