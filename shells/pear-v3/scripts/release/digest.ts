/**
 * The digest a notice names, on Node: `src/update/hash.ts`, the code the update gate itself runs,
 * given Node's file access. There is no second implementation of the tree hash here.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join } from 'node:path';

import { artifactDigest, type HashFs, type Sha256Factory } from '../../src/update/hash.ts';

export const nodeHashFs: HashFs = {
  lstat: (p) => lstat(p),
  readdir: (p) => readdir(p),
  readlink: (p) => readlink(p),
  read: (p) => createReadStream(p) as AsyncIterable<Uint8Array>,
  join: (a, b) => join(a, b),
};

export const nodeSha256: Sha256Factory = () => {
  const h = createHash('sha256');
  return {
    update: (b) => {
      h.update(b);
    },
    digestHex: () => h.digest('hex'),
  };
};

/** The digest a notice names for this artifact: see `src/update/hash.ts`. */
export const digestOf = (path: string): Promise<string> =>
  artifactDigest(nodeHashFs, nodeSha256, path);

/**
 * The `<bytes>` of an artifact tag: a file's size, or for a bundle the sum of its regular files'
 * sizes (a symlink counts for nothing). The update gate does not read it; a person comparing a
 * notice with a download does.
 */
export async function artifactBytes(path: string): Promise<number> {
  const st = await lstat(path);
  if (st.isFile()) return st.size;
  if (!st.isDirectory()) throw new Error(`${path} is neither a file nor a directory`);
  let total = 0;
  for (const name of await readdir(path)) {
    const p = join(path, name);
    const s = await lstat(p);
    if (s.isDirectory()) total += await artifactBytes(p);
    else if (s.isFile()) total += s.size;
  }
  return total;
}
