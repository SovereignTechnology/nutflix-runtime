import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `shells/pear-v3`. */
export const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** The repository root (npm's workspace root: `node_modules`, `package-lock.json`). */
export const REPO_ROOT = resolve(PKG_DIR, '..', '..');
