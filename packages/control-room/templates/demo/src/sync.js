// Paper Plane sync: merge two versions of a note paragraph by paragraph.
export function mergeParagraphs(base, ours, theirs) {
  const b = base.split('\n\n');
  const o = ours.split('\n\n');
  const t = theirs.split('\n\n');
  const out = [];
  for (let i = 0; i < Math.max(o.length, t.length); i++) {
    if (o[i] === t[i]) out.push(o[i]);
    else if (o[i] === b[i]) out.push(t[i]);
    else out.push(o[i] ?? t[i]);
  }
  return out.filter((p) => p !== undefined).join('\n\n');
}
