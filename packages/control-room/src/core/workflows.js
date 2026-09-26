// Workflows: Markdown files with "## Step N: title" headings. A step whose heading
// says GATE or SIGN-OFF is a human gate: the agent stops there and asks.
import path from 'node:path';
import { listFiles, readText } from 'flowrail/api';

const STEP_RE = /^##\s+Step\s+(\d+)\s*[:.)–—-]?\s*(.*)$/i;
const GATE_RE = /\bgate\b|\bsign[- ]?off\b/i;

export function parseWorkflow(text, file = '') {
  const lines = String(text).split('\n');
  let title = '';
  const intro = [];
  const steps = [];
  let cur = null;
  for (const line of lines) {
    const step = STEP_RE.exec(line);
    if (step) {
      cur = { n: Number(step[1]), title: step[2].trim(), gate: GATE_RE.test(step[2]), body: '' };
      steps.push(cur);
      continue;
    }
    if (!title && /^#\s+/.test(line)) { title = line.replace(/^#\s+/, '').trim(); continue; }
    if (cur) cur.body += line + '\n';
    else if (title) intro.push(line);
  }
  for (const s of steps) s.body = s.body.trim();
  return {
    file,
    title: title || path.basename(file, '.md').replace(/[-_]+/g, ' '),
    description: intro.join('\n').trim().split(/\n\s*\n/)[0] || '',
    steps,
  };
}

export function list(p) {
  return listFiles(p.workflows, '.md').map((f) => parseWorkflow(readText(path.join(p.workflows, f)), `flowrail/workflows/${f}`));
}
