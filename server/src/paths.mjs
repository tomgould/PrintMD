/** Where things live: the repository root (shared app modules) and server/. */
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const SERVER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = resolve(SERVER_ROOT, '..');
