// Workflows: Markdown files with "## Step N: title" headings. A step whose heading
// says GATE or SIGN-OFF is a human gate: the agent stops there and asks. A file can also hold
// several routines in one: "## Action: add" or "## Sub-command: send" headings open a group, and
// the steps under a group ("### Step 1: …" or "## Step 1: …") belong to it.
// The folder is flowrail/workflows unless config.json names another one ("workflowsDir").
import path from 'node:path';
import { listFiles, readText, loadConfig } from 'flowrail/api';

const STEP_RE = /^#{2,4}\s+Step\s+(\d+)\s*[:.)–—-]?\s*(.*)$/i;
const GROUP_RE = /^##\s+(Action|Sub-?command)\s*[:.–—-]\s*(.+)$/i;
const GATE_RE = /\bgate\b|\bsign[- ]?off\b|\bmandatory\b/i;

export function parseWorkflow(text, file = '') {
  const lines = String(text).split('\n');
  let title = '';
  const intro = [];
  const steps = [];
  const groups = [];
  let group = null;
  let cur = null;
  for (const line of lines) {
    const g = GROUP_RE.exec(line);
    if (g) {
      group = { kind: /^action/i.test(g[1]) ? 'action' : 'sub-command', title: g[2].trim(), steps: [] };
      groups.push(group);
      cur = null;
      continue;
    }
    const step = STEP_RE.exec(line);
    if (step) {
      cur = { n: Number(step[1]), title: step[2].trim(), gate: GATE_RE.test(step[2]), body: '' };
      (group ? group.steps : steps).push(cur);
      continue;
    }
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
    if (cur) cur.body += line + '\n';
    else if (title && !group) intro.push(line);
  }
  for (const s of [...steps, ...groups.flatMap((x) => x.steps)]) s.body = s.body.trim();
  return {
    file,
    title: title || path.basename(file, '.md').replace(/[-_]+/g, ' '),
    description: intro.join('\n').trim().split(/\n\s*\n/)[0] || '',
    steps,
    groups,
  };
}

/** The workflows folder: config "workflowsDir" when it names a folder inside the repo. */
export function workflowsDir(p) {
  const rel = loadConfig(p).workflowsDir;
  if (typeof rel !== 'string' || !rel.trim() || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) return p.workflows;
  return path.join(p.root, rel);
}

export function list(p) {
  const dir = workflowsDir(p);
  const rel = path.relative(p.root, dir).split(path.sep).join('/');
  return listFiles(dir, '.md').filter((f) => f !== 'README.md')
    .map((f) => parseWorkflow(readText(path.join(dir, f)), `${rel}/${f}`))
    .filter((w) => w.steps.length || w.groups.length);
}
