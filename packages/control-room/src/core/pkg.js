// Where this package lives and its version.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const VERSION = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8')).version;
