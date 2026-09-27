// A board snapshot as one self-contained HTML file: inline CSS in flowrail's colours, light and dark
// from the reader's system, no scripts and nothing fetched. Pass it what a board store's read() returns.
const COLS = ['Todo', 'In Progress', 'Review', 'Done'];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `:root{--bg:#F7F7F5;--surface:#fff;--tray:#EFEFEC;--line:rgb(20 22 20/.09);--text:#16181A;--text2:#5A5F63;--accent:#0E7C66;--warn:#9A5B00;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0F1113;--surface:#16191C;--tray:#1C2024;--line:rgb(255 255 255/.08);--text:#ECEEEF;--text2:#A3A9AE;--accent:#3DD6AC;--warn:#F2B35B;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;padding:32px;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
h1{margin:0;font-size:20px}h2{margin:32px 0 12px;font-size:15px}.meta{color:var(--text2);font-size:13px;margin:4px 0 20px}
.board{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.col{background:var(--tray);border-radius:14px;padding:10px}
.col h3{margin:2px 4px 10px;font-size:13px;font-weight:500}.col h3 span{color:var(--text2);font-weight:400}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:10px 12px;margin-bottom:8px}
.id{font:12px ui-monospace,Menlo,monospace;color:var(--text2)}.prio{font:12px ui-monospace,Menlo,monospace;color:var(--warn);margin-left:6px}
.t{margin:4px 0 6px}.foot{font-size:12px;color:var(--text2)}table{width:100%;border-collapse:collapse;background:var(--surface);border-radius:10px}
td,th{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);font-size:13px}th{color:var(--text2);font-weight:500}
@media (max-width:760px){body{padding:16px}.board{grid-template-columns:1fr}}`;

/** The HTML page for a board: { config: { current }, tasks }. `backlog: true` adds the unscheduled tasks. */
export function boardHtml(data, { name = 'Board', backlog = false, at = new Date() } = {}) {
  const cur = data.config?.current || {};
  const inSprint = data.tasks.filter((t) => t.sprint && t.sprint === cur.start);
  const card = (t) => `<div class="card"><span class="id">${esc(t.id)}</span><span class="prio">${esc(t.priority)}</span><div class="t">${esc(t.title)}</div><div class="foot">${esc([t.assignee, t.group, ...(t.labels || [])].filter(Boolean).join(' · '))}</div></div>`;
  const cols = COLS.map((c) => { const list = inSprint.filter((t) => t.status === c); return `<section class="col"><h3>${esc(c)} <span>${list.length}</span></h3>${list.map(card).join('')}</section>`; }).join('');
  const rest = backlog ? data.tasks.filter((t) => !t.sprint && t.status !== 'Done') : [];
  const table = backlog ? `<h2>Backlog (${rest.length})</h2>${rest.length ? `<table><tr><th>Task</th><th>Priority</th><th>Assignee</th></tr>${rest.map((t) => `<tr><td>${esc(t.id)} ${esc(t.title)}</td><td>${esc(t.priority)}</td><td>${esc(t.assignee)}</td></tr>`).join('')}</table>` : ''}` : '';
  const done = inSprint.filter((t) => t.status === 'Done').length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${esc(name)} · ${esc(cur.label || 'Board')}</title><style>${CSS}</style></head><body>
<h1>${esc(name)}: ${esc(cur.label || 'Board')}</h1><p class="meta">${esc(cur.start || '')}${cur.end ? ` to ${esc(cur.end)}` : ''} · ${done} of ${inSprint.length} done · exported ${esc(at.toISOString().slice(0, 16).replace('T', ' '))}</p>
<div class="board">${cols}</div>${table}</body></html>\n`;
}
