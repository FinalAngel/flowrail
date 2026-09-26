// Paper Plane store: one Markdown file per note.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function readNote(folder, id) {
  return readFile(join(folder, `${id}.md`), 'utf8');
}

export async function writeNote(folder, id, text) {
  await writeFile(join(folder, `${id}.md`), text);
}
