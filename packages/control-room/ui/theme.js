// Runs before first paint so a chosen theme never flashes. Classic script: CSP 'self' allows it.
// ?theme=light|dark overrides the stored choice (screenshots); ?shot=1 hides the demo banner.
try {
  const q = new URLSearchParams(location.search);
  let t = q.get('theme');
  if (t !== 'light' && t !== 'dark') t = localStorage.getItem('flowrail-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  if (q.get('shot') === '1') document.documentElement.dataset.shot = '1';
} catch {}
