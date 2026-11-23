/**
 * The one digest a notice names for an artifact, computed the same way in the app (Bare) and in CI
 * (Node), over injected file access.
 *
 *   - A regular file (`Nutflix.AppImage`, `Nutflix.msix`): the sha256 of its bytes.
 *   - A directory (`Nutflix.app`): the sha256 of one JSON line per file and symlink, sorted by path:
 *     `["<path>","file",<true|false owner-executable>,"<sha256 of bytes>"]\n` or
 *     `["<path>","link",false,"<target>"]\n`. JSON because a file name or a link target may hold a
 *     newline: with plain separators, two different trees could serialize to the same text.
 *     A bundle's symlinks and executable bits are part of what is signed.
 *
 * A symlink at the top, or any special file inside, is refused: nothing a notice names is one.
 */

export interface HashStat {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly mode: number;
}

export interface HashFs {
  lstat(path: string): Promise<HashStat>;
  readdir(path: string): Promise<string[]>;
  readlink(path: string): Promise<string>;
  read(path: string): AsyncIterable<Uint8Array>;
  join(a: string, b: string): string;
}

export interface Sha256 {
  update(bytes: Uint8Array): void;
  digestHex(): string;
}

export type Sha256Factory = () => Sha256;

/** No bundle holds more; a tree that does is refused rather than walked for ever. */
export const MAX_TREE_ENTRIES = 200_000;

async function fileDigest(fs: HashFs, sha: Sha256Factory, path: string): Promise<string> {
  const h = sha();
  for await (const chunk of fs.read(path)) h.update(chunk);
  return h.digestHex();
}

const encoder = new TextEncoder();

/** The artifact's digest: see the header. */
export async function artifactDigest(
  fs: HashFs,
  sha: Sha256Factory,
  path: string,
): Promise<string> {
  const top = await fs.lstat(path);
  if (top.isSymbolicLink()) throw new Error('an artifact is not a symlink');
  if (top.isFile()) return fileDigest(fs, sha, path);
  if (!top.isDirectory()) throw new Error('an artifact is a file or a directory');

  const lines: { key: string; line: string }[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const name of await fs.readdir(dir)) {
      if (lines.length >= MAX_TREE_ENTRIES) throw new Error('the bundle has too many entries');
      const p = fs.join(dir, name);
      const key = rel === '' ? name : `${rel}/${name}`;
      const st = await fs.lstat(p);
      if (st.isSymbolicLink())
        lines.push({
          key,
          line: `${JSON.stringify([key, 'link', false, await fs.readlink(p)])}\n`,
        });
      else if (st.isDirectory()) await walk(p, key);
      else if (st.isFile()) {
        const exec = (st.mode & 0o100) !== 0;
        const digest = await fileDigest(fs, sha, p);
        lines.push({ key, line: `${JSON.stringify([key, 'file', exec, digest])}\n` });
      } else throw new Error('a bundle holds only files and symlinks');
    }
  };
  await walk(path, '');
  lines.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const h = sha();
  for (const l of lines) h.update(encoder.encode(l.line));
  return h.digestHex();
}
