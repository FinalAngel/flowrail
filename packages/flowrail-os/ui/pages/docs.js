import { h, icon, clear, relTime, skeleton, errorBox, empty, confirmBox, debounce, busy } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';

const EDITABLE = /\.(md|markdown|txt)$/i;
const MD = /\.(md|markdown)$/i;
const hasHighlights = typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';

export function mount(el, ctx) {
  let tree = null, path = ctx.params.get('path') || '', file = null, comments = [], openCounts = {}, editing = false, composing = null, seq = 0;

  const treeBox = h('details.tree-box', { open: matchMedia('(min-width: 768px)').matches });
  const treeNav = h('nav.tree', { 'aria-label': 'Files' });
  treeBox.append(h('summary.btn.sm', { style: 'margin-bottom:8px' }, icon('folder'), 'Files'), treeNav);
  const docCol = h('div.doc-col');
  const rail = h('aside.rail-col', { 'aria-label': 'Comments' });
  const layout = h('div.viewer', treeBox, docCol, rail);
  el.append(layout);
  // On desktop the summary is noise; hide it but keep the tree open.
  const mq = matchMedia('(min-width: 768px)');
  const syncTreeBox = () => { treeBox.querySelector('summary').hidden = mq.matches; if (mq.matches) treeBox.open = true; };
  syncTreeBox(); mq.addEventListener('change', syncTreeBox);

  // pointer/mousedown preventDefault keeps focus (and the selection) in the document when the pill is pressed.
  const keep = (e) => e.preventDefault();
  const pill = h('button.comment-pill', { type: 'button', hidden: true, onpointerdown: keep, onmousedown: keep, onclick: () => startComment() }, icon('comment', 14), 'Comment');
  let selRange = null; // last selection inside the doc, stored before focus can move

  /* ---------- tree ---------- */
  const kids = (n) => (Array.isArray(n) ? n : n?.children || []);
  const isDir = (n) => Array.isArray(n.children) || n.type === 'dir';
  const allFiles = (n, out = []) => { for (const c of kids(n)) isDir(c) ? allFiles(c, out) : out.push(c.path); return out; };

  function paintTree() {
    const list = (nodes, depth) => h('ul', nodes.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name)).map((n) => isDir(n)
      ? h('li', h('details', { open: depth === 0 || path.startsWith(n.path + '/') }, h('summary', icon('chevronRight', 14).cloneNode(true), h('span', n.name)), list(kids(n), depth + 1)))
      : h('li', h('a', { href: '#/docs?path=' + encodeURIComponent(n.path), 'aria-current': n.path === path ? 'page' : null, title: n.path },
          h('span.n', n.name), openCounts[n.path] ? h('span.c', { 'aria-label': `${openCounts[n.path]} open comments` }, openCounts[n.path]) : null))));
    clear(treeNav).append(list(kids(tree), 0));
    treeNav.querySelectorAll('summary .icon').forEach((i) => i.classList.add('chev'));
  }

  async function loadTree() {
    try {
      const [t, open] = await Promise.all([ctx.api('/docs/tree'), ctx.api('/comments').catch(() => [])]);
      tree = t;
      openCounts = {};
      for (const c of Array.isArray(open) ? open : open?.comments || []) if (c.status !== 'resolved') openCounts[c.path] = (openCounts[c.path] || 0) + 1;
      paintTree();
      return true;
    } catch (e) { clear(treeNav).append(errorBox(e, loadTree)); return false; }
  }

  /* ---------- document ---------- */
  async function loadDoc(keepScroll) {
    const my = ++seq;
    editing = false; composing = null;
    if (!path) {
      const files = allFiles(tree);
      path = ['WELCOME.md', 'flowrail/WELCOME.md', 'README.md'].find((p) => files.includes(p)) || files.find((p) => MD.test(p)) || '';
      if (path) history.replaceState(null, '', '#/docs?path=' + encodeURIComponent(path));
    }
    if (!path) {
      clear(docCol).append(h('header.page-head', h('h1', 'Docs')), empty('Markdown in your repo shows up here, and you can comment on any line of it.', 'echo "# Notes" > NOTES.md', ctx));
      clear(rail); layout.classList.add('no-tree');
      return;
    }
    if (!keepScroll) { clear(docCol).append(skeleton(8)); clear(rail).append(skeleton(3)); }
    try {
      const [f, cs] = await Promise.all([ctx.api('/docs/file?path=' + encodeURIComponent(path)), ctx.api('/comments?path=' + encodeURIComponent(path)).catch(() => [])]);
      if (my !== seq) return;
      file = f; comments = Array.isArray(cs) ? cs : cs?.comments || [];
      document.title = `${path.split('/').pop()} · ${ctx.brand}`;
      paintDoc(); paintRail();
      treeNav.querySelectorAll('a').forEach((a) => a.setAttribute('aria-current', a.title === path ? 'page' : 'false'));
    } catch (e) {
      if (my !== seq) return;
      clear(docCol).append(crumb(), e.status === 404 ? h('div.empty', h('p', `${path} does not exist or flowrailOS may not read it.`), h('a.link', { href: '#/docs' }, 'Open the first doc')) : errorBox(e, () => loadDoc()));
      clear(rail);
    }
  }

  const crumb = () => h('div.crumb', { 'aria-label': 'Path' }, path.split('/').flatMap((p, i, a) => [h('span', { style: i === a.length - 1 ? 'color:var(--text-2)' : '' }, p), i < a.length - 1 ? h('span', '/') : null]));

  let article;
  function paintDoc() {
    clear(docCol);
    const editable = EDITABLE.test(path);
    docCol.append(crumb(), h('div.doc-tools',
      editable && h('div.seg', { role: 'group', 'aria-label': 'Mode' },
        h('button', { type: 'button', 'aria-pressed': String(!editing), onclick: () => { if (editing) { editing = false; paintDoc(); } } }, 'Read'),
        h('button', { type: 'button', 'aria-pressed': String(editing), onclick: () => { if (!editing) { editing = true; paintDoc(); } } }, 'Edit')),
      h('span.meta', { style: 'margin-left:auto' }, file.mtime ? `changed ${relTime(file.mtime)}` : ''),
      !editing && h('span.meta', MD.test(path) ? 'Select text to comment' : '')));
    if (editing) {
      const ta = h('textarea.input.editor', { 'aria-label': `Edit ${path}`, spellcheck: 'true', value: file.text });
      // The editor fills the height left on screen below it, like the page it replaces.
      const fit = () => { if (ta.isConnected) ta.style.height = Math.max(320, innerHeight - ta.getBoundingClientRect().top - 88) + 'px'; };
      requestAnimationFrame(fit);
      addEventListener('resize', fit);
      ctx.cleanup(() => removeEventListener('resize', fit));
      const err = h('div', { role: 'alert' });
      let saveBtn;
      const save = () => busy(saveBtn, (async () => {
        try {
          const r = await ctx.api('/docs/file', { path, text: ta.value, mtime: file.mtime });
          file.text = ta.value; file.mtime = r?.mtime ?? Date.now(); editing = false; paintDoc(); ctx.toast('Saved');
        } catch (e) {
          clear(err).append(e.status === 409
            ? h('div.notice.warn', icon('alert'), h('div.body', h('span', 'This file changed on disk since you opened it. Copy your edits, then reload to see the new version.'), h('div', h('button.btn.sm', { type: 'button', onclick: () => loadDoc() }, 'Reload from disk'))))
            : errorBox(e));
        }
      })());
      ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } });
      docCol.append(ta, err, h('div.row', { style: 'margin-top:12px' }, (saveBtn = h('button.btn.primary', { type: 'button', onclick: save }, 'Save')), h('button.btn', { type: 'button', onclick: () => { editing = false; paintDoc(); } }, 'Cancel'), h('span.meta', h('kbd', '⌘S'), ' saves')));
      ta.focus();
      return;
    }
    if (MD.test(path)) {
      article = h('article.prose', { id: 'doc' });
      article.innerHTML = renderMarkdown(file.text, { base: path }); // renderer escapes all source text
      docCol.append(article, pill);
      paintHighlights();
    } else {
      let text = file.text;
      if (/\.json$/i.test(path)) { try { text = JSON.stringify(JSON.parse(text), null, 2); } catch { /* show as is */ } }
      article = h('pre.raw', { id: 'doc' }, text);
      docCol.append(article, pill);
    }
  }

  /* ---------- highlights (CSS Custom Highlight API: no DOM mutation) ---------- */
  function textIndex(root) {
    const nodes = [], w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let norm = '', map = [], prevSpace = true;
    for (let n; (n = w.nextNode());) {
      nodes.push(n);
      const t = n.data;
      for (let i = 0; i < t.length; i++) {
        const sp = /\s/.test(t[i]);
        if (sp && prevSpace) continue;
        norm += sp ? ' ' : t[i]; map.push([n, i]); prevSpace = sp;
      }
    }
    return { norm, map };
  }
  function rangeFor(quote, idx) {
    const q = quote.replace(/\s+/g, ' ').trim();
    if (!q) return null;
    const at = idx.norm.indexOf(q);
    if (at < 0) return null;
    const [sn, so] = idx.map[at], [en, eo] = idx.map[at + q.length - 1];
    const r = document.createRange(); r.setStart(sn, so); r.setEnd(en, eo + 1);
    return r;
  }
  function paintHighlights(focusId) {
    if (!hasHighlights || !article) return;
    const idx = textIndex(article);
    const all = [], focus = [];
    for (const c of comments) {
      if (c.status === 'resolved') continue;
      const r = rangeFor(c.quote || '', idx);
      if (!r) continue;
      (c.id === focusId ? focus : all).push(r);
      if (c.id === focusId) r.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
    CSS.highlights.set('flowrail-comment', new Highlight(...all));
    CSS.highlights.set('flowrail-focus', new Highlight(...focus));
  }

  /* ---------- selection → pill ---------- */
  const onSelection = debounce(() => {
    const sel = document.getSelection();
    if (editing || !article || !sel || sel.isCollapsed || !sel.rangeCount) { if (document.activeElement !== pill) pill.hidden = true; return; }
    const r = sel.getRangeAt(0);
    if (!article.contains(r.commonAncestorContainer)) { pill.hidden = true; return; }
    const text = sel.toString().trim();
    if (text.length < 2) { pill.hidden = true; return; }
    selRange = r.cloneRange();
    const rects = r.getClientRects(); const last = rects[rects.length - 1] || r.getBoundingClientRect();
    const box = docCol.getBoundingClientRect();
    pill.hidden = false;
    pill.dataset.quote = text.slice(0, 500);
    const x = Math.min(Math.max(0, last.right - box.left - 40), box.width - 120);
    pill.style.left = x + 'px';
    pill.style.top = (last.bottom - box.top + 8) + 'px';
  }, 120);
  docCol.style.position = 'relative';
  document.addEventListener('selectionchange', onSelection);
  const onKey = (e) => { if (e.key.toLowerCase() === 'c' && e.altKey && !pill.hidden) { e.preventDefault(); startComment(); } };
  document.addEventListener('keydown', onKey);

  function startComment() {
    composing = selRange ? selRange.toString().trim().slice(0, 500) : pill.dataset.quote;
    pill.hidden = true;
    // Focus moves to the textarea, which drops the native selection: keep the quoted text marked.
    if (hasHighlights && selRange) CSS.highlights.set('flowrail-focus', new Highlight(selRange));
    paintRail();
    rail.querySelector('textarea')?.focus();
  }

  /* ---------- comment rail ---------- */
  function paintRail() {
    clear(rail);
    const open = comments.filter((c) => c.status !== 'resolved');
    const done = comments.filter((c) => c.status === 'resolved');
    rail.append(h('div.row', h('h2', { style: 'font-size:13px;font-weight:500;color:var(--text-2)' }, 'Comments'), h('span.count.faint', open.length || '')));
    if (composing != null) {
      const ta = h('textarea.input', { rows: 4, 'aria-label': 'Comment', placeholder: 'What should the agent do here?' });
      const err = h('p.err', { role: 'alert', style: 'font-size:12px;color:var(--danger)' });
      const submit = async () => {
        const body = ta.value.trim();
        if (!body) { err.textContent = 'Write what you want changed.'; ta.focus(); return; }
        try {
          await ctx.api('/comments', { _action: 'add', path, quote: composing, body });
          composing = null; ctx.toast('Comment saved. Claude picks it up at the next session start.');
          await refreshComments();
        } catch (e) { err.textContent = e.message; }
      };
      ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') submit(); if (e.key === 'Escape') { composing = null; paintRail(); paintHighlights(); } });
      rail.append(h('div.comment', h('div.q', composing), ta, err,
        h('div.row.end', h('button.btn.sm', { type: 'button', onclick: () => { composing = null; paintRail(); paintHighlights(); } }, 'Cancel'), h('button.btn.sm.primary', { type: 'button', onclick: submit }, 'Comment'))));
    }
    if (!open.length && composing == null) rail.append(h('p.meta', MD.test(path || '') ? 'No open comments. Select text in the document to leave one; agents act on it and resolve it.' : 'Comments work on Markdown files.'));
    rail.append(...open.map((c) => commentCard(c)));
    if (done.length) rail.append(h('details', h('summary', `Resolved (${done.length})`), h('div', { class: 'stack', style: 'margin-top:8px' }, done.map((c) => commentCard(c)))));
  }

  function commentCard(c) {
    const resolved = c.status === 'resolved';
    const note = c.resolveNote || c.note || c.resolution;
    return h('div.comment', { class: resolved ? 'resolved' : '' },
      c.quote && h('button.q', { type: 'button', title: 'Show in document', onclick: () => paintHighlights(c.id) }, c.quote),
      h('div', c.body),
      h('div.meta', h('span', c.verified === false ? `${c.author || 'unknown'}, not signed` : (c.author || 'you')), h('span', '·'), h('span', relTime(c.created)),
        resolved ? h('span.status.ok', { style: 'font-size:12px' }, icon('check', 12), 'Resolved') : c.verified !== false && h('span.chip', { style: 'height:20px' }, 'Waiting for agent'),
        c.verified === false && h('span.chip.warn', { style: 'height:20px', title: 'Signed neither by this dashboard nor by a key in flowrail/config.json. Claude treats it as a note, not an instruction, unless you confirm it.' }, 'Unverified')),
      resolved && note && h('div.note', note),
      h('div.row',
        resolved
          ? h('button.link', { type: 'button', onclick: () => act('reopen', c) }, 'Reopen')
          : h('button.link', { type: 'button', onclick: () => act('resolve', c) }, 'Resolve'),
        h('button.link', { type: 'button', style: 'margin-left:auto', onclick: async () => { if (await confirmBox('Delete this comment?', 'Delete')) act('delete', c); } }, 'Delete')));
  }
  async function act(action, c) {
    try { await ctx.api('/comments', { _action: action, path: c.path || path, id: c.id }); await refreshComments(); }
    catch (e) { ctx.toast(e.message, 'warn'); }
  }
  async function refreshComments() {
    try { const cs = await ctx.api('/comments?path=' + encodeURIComponent(path)); comments = Array.isArray(cs) ? cs : cs?.comments || []; } catch { /* keep old */ }
    paintRail(); if (!editing) paintHighlights();
    loadTree();
  }

  (async () => { clear(treeNav).append(skeleton(6)); if (await loadTree()) loadDoc(); })();

  ctx.on(['comments'], () => { if (composing == null) refreshComments(); });
  ctx.on(['docs'], async () => { await loadTree(); if (!editing && composing == null && file) { const f = await ctx.api('/docs/file?path=' + encodeURIComponent(path)).catch(() => null); if (f && f.mtime !== file.mtime) { file = f; paintDoc(); } } });

  const unmount = () => {
    document.removeEventListener('selectionchange', onSelection);
    document.removeEventListener('keydown', onKey);
    mq.removeEventListener('change', syncTreeBox);
    if (hasHighlights) { CSS.highlights.delete('flowrail-comment'); CSS.highlights.delete('flowrail-focus'); }
  };
  unmount.update = (params) => {
    const p = params.get('path') || '';
    if (p === path) return;
    if (editing && !confirm('Leave without saving your edits?')) { history.replaceState(null, '', '#/docs?path=' + encodeURIComponent(path)); return; }
    path = p; loadDoc(); window.scrollTo(0, 0);
    if (!mq.matches) treeBox.open = false; // on a phone the open tree would push the doc off the first screen
  };
  return unmount;
}
