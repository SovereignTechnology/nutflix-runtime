/**
 * The deployment folder `pear build` makes, and the checks that compare bytes before and after the
 * trip through Pear: a file's sha256, a tree's manifest (every file's hash and executable bit,
 * every symlink's target) and what two manifests disagree on.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { join, posix, sep } from 'node:path';

import { APP } from '../../packaging/identity.ts';
import { appFileName } from './pins.ts';

/**
 * The project's `package.json` for `pear build` and `pear stage`: the packaged app's own fields
 * (`packaging/stage.ts`) and nothing that points anywhere. It has no update link: the link an app
 * follows is compiled into its updater at package time (`packaging/update-root.ts`), and a field
 * here could not change it.
 */
export function deploymentPackageJson(o: { version: string }): string {
  return `${JSON.stringify(
    {
      name: APP.name,
      productName: APP.productName,
      version: o.version,
      description: APP.description,
      license: APP.license,
      author: APP.author,
    },
    null,
    2,
  )}\n`;
}

/** The five entries a complete deployment holds: `by-arch/<target>/app/<productName>.<ext>`. */
export function expectedDeploymentEntries(
  targets: readonly { platform: 'linux' | 'darwin' | 'win32'; arch: string }[],
): string[] {
  return targets
    .map((t) => `by-arch/${t.platform}-${t.arch}/app/${appFileName(t.platform, APP.productName)}`)
    .sort();
}

/** sha256 of a file, streamed. */
export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

export interface TreeEntry {
  readonly kind: 'file' | 'link';
  /** sha256 of a file's bytes. */
  readonly sha256?: string;
  /** Whether the owner may execute it (the one mode bit Pear keeps; absent where there are no modes). */
  readonly exec?: boolean;
  /** A link's target, as written. */
  readonly target?: string;
}

/** Relative path (always `/`) to entry, for every file and symlink under `root`. */
export type TreeManifest = ReadonlyMap<string, TreeEntry>;

/** Hashes every file under `root`, one at a time (a bundle is thousands of files). */
export async function treeManifest(root: string): Promise<TreeManifest> {
  const out = new Map<string, TreeEntry>();
  const modes = process.platform !== 'win32';
  const walk = async (dir: string, rel: string): Promise<void> => {
    const names = (await readdir(dir)).sort();
    for (const name of names) {
      const full = join(dir, name);
      const key = rel === '' ? name : `${rel}/${name}`;
      const st = await lstat(full);
      if (st.isSymbolicLink()) {
        out.set(key, { kind: 'link', target: await readlink(full) });
      } else if (st.isDirectory()) {
        await walk(full, key);
      } else if (st.isFile()) {
        out.set(key, {
          kind: 'file',
          sha256: await sha256File(full),
          ...(modes ? { exec: (st.mode & 0o100) !== 0 } : {}),
        });
      }
    }
  };
  await walk(root, '');
  return out;
}

/** The files of a manifest, without its symlinks (a Windows file system cannot keep a bundle's). */
export function filesOnly(m: TreeManifest): TreeManifest {
  return new Map([...m].filter(([, e]) => e.kind === 'file'));
}

/** What differs between a tree before Pear and after (empty = the same). At most `limit` lines. */
export function manifestProblems(before: TreeManifest, after: TreeManifest, limit = 20): string[] {
  const problems: string[] = [];
  const add = (s: string): void => {
    problems.push(s);
  };
  for (const [path, a] of before) {
    const b = after.get(path);
    if (b === undefined) add(`missing after: ${path}`);
    else if (a.kind !== b.kind) add(`${path}: ${a.kind} became ${b.kind}`);
    else if (a.kind === 'link' && a.target !== b.target)
      add(`${path}: link to ${String(a.target)} became ${String(b.target)}`);
    else if (a.kind === 'file' && a.sha256 !== b.sha256) add(`${path}: the bytes differ`);
    else if (a.kind === 'file' && a.exec !== b.exec)
      add(`${path}: executable ${String(a.exec)} became ${String(b.exec)}`);
  }
  for (const path of after.keys()) if (!before.has(path)) add(`extra after: ${path}`);
  if (problems.length > limit) {
    const n = problems.length;
    problems.length = limit;
    problems.push(`... and ${String(n - limit)} more`);
  }
  return problems;
}

/** `{ files, links, bytes-free digest }` of a manifest: one line for the log. */
export function manifestSummary(m: TreeManifest): { files: number; links: number; digest: string } {
  const h = createHash('sha256');
  let files = 0;
  let links = 0;
  for (const path of [...m.keys()].sort()) {
    const e = m.get(path);
    if (e === undefined) continue;
    if (e.kind === 'file') files++;
    else links++;
    h.update(`${path}\0${e.kind}\0${e.sha256 ?? e.target ?? ''}\0${String(e.exec ?? '')}\n`);
  }
  return { files, links, digest: h.digest('hex').slice(0, 16) };
}

/** Every file path under `dir`, `/`-separated and relative: the deployment's file list. */
export async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const key = rel === '' ? e.name : posix.join(rel, e.name);
      if (e.isDirectory()) await walk(join(d, e.name), key);
      else out.push(key);
    }
  };
  await walk(dir, '');
  return out.sort();
}

/** A path with this platform's separators, for messages. */
export const native = (p: string): string => p.split('/').join(sep);
