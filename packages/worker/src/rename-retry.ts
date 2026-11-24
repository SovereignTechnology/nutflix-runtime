/**
 * A rename, an unlink and a recursive remove that ride out Windows' brief sharing violations, for
 * every one the worker makes: its `SeederFs` (so the NFX store, `seeding.json` and the play spools
 * too), the durable writes of `./adapters/bare.ts`, and its `rmTree` (the `tmp/` wipe at `init`,
 * a play's spool, Studio's work folders). Runtime-neutral: the caller names the platform
 * (`Bare.platform`, `process.platform`) and hands in the operation itself.
 *
 * On Windows, renaming over or deleting a file that another process holds open for a moment
 * (Defender or the search indexer, reading a file that was just written) fails with EPERM, EACCES
 * or EBUSY, and the same call works a few milliseconds later. A recursive remove also meets
 * ENOTEMPTY: a file inside that was held open is only marked for deletion, so its folder is not
 * empty yet. So on `win32`, and for those codes only, it is tried again, waiting 10 ms, then twice
 * as long each time (at most 500 ms), until the waits would pass `RENAME_RETRY_BUDGET_MS`; then the
 * last error is thrown as it came. A file that is really locked, or really forbidden, still fails,
 * about three seconds later.
 *
 * Nothing else is retried: another code, or any code on another platform, where EPERM and EACCES
 * mean what they say, is thrown at once. Each attempt is the caller's whole operation, so a durable
 * write keeps its order: the temporary file synced, then the rename, then the directory synced.
 */
import type { SeederFs } from '@sovit/seeder';

/** What a sharing violation looks like on Windows: libuv's codes for it, from Node and bare-fs. */
export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** An unlink meets the same violations as a rename. */
export const TRANSIENT_UNLINK_CODES: ReadonlySet<string> = TRANSIENT_RENAME_CODES;

/** A recursive remove meets them too, and a folder whose last file is still being deleted. */
export const TRANSIENT_RM_TREE_CODES: ReadonlySet<string> = new Set([
  ...TRANSIENT_RENAME_CODES,
  'ENOTEMPTY',
]);

/** The most it waits between attempts, in all, for any one operation. */
export const RENAME_RETRY_BUDGET_MS = 3000;
const FIRST_WAIT_MS = 10;
const MAX_WAIT_MS = 500;

export interface RenameRetryOptions {
  /** `Bare.platform` or `process.platform`: only `win32` retries. */
  readonly platform: string;
  /** TESTS ONLY: a clock of the test's own. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isTransient(err: unknown, codes: ReadonlySet<string>): boolean {
  if (typeof err !== 'object' || err === null) return false;
  try {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && codes.has(code);
  } catch {
    return false;
  }
}

/** `op()`, tried again on Windows while it fails with one of `codes`. */
async function retryingOnWindows(
  op: () => Promise<void>,
  codes: ReadonlySet<string>,
  o: RenameRetryOptions,
): Promise<void> {
  if (o.platform !== 'win32') {
    await op();
    return;
  }
  const sleep = o.sleep ?? wait;
  let waited = 0;
  let next = FIRST_WAIT_MS;
  for (;;) {
    try {
      await op();
      return;
    } catch (err) {
      if (!isTransient(err, codes) || waited + next > RENAME_RETRY_BUDGET_MS) throw err;
    }
    await sleep(next);
    waited += next;
    next = Math.min(next * 2, MAX_WAIT_MS);
  }
}

/** `rename(from, to)`, tried again on Windows while it fails as a sharing violation. */
export function renameRetrying(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  o: RenameRetryOptions,
): Promise<void> {
  return retryingOnWindows(() => rename(from, to), TRANSIENT_RENAME_CODES, o);
}

/** `unlink(p)`, tried again on Windows while it fails as a sharing violation. */
export function unlinkRetrying(
  unlink: (p: string) => Promise<void>,
  p: string,
  o: RenameRetryOptions,
): Promise<void> {
  return retryingOnWindows(() => unlink(p), TRANSIENT_UNLINK_CODES, o);
}

/**
 * `rmTree(p)`, a recursive remove, tried again on Windows while it fails as a sharing violation or
 * a folder not yet empty. Each attempt is the whole remove: what the last one deleted stays deleted.
 */
export function rmTreeRetrying(
  rmTree: (p: string) => Promise<void>,
  p: string,
  o: RenameRetryOptions,
): Promise<void> {
  return retryingOnWindows(() => rmTree(p), TRANSIENT_RM_TREE_CODES, o);
}

/** `fs` with its `rename` and `unlink` through `renameRetrying` and `unlinkRetrying`. */
export function withSharingRetry(fs: SeederFs, o: RenameRetryOptions): SeederFs {
  return {
    ...fs,
    rename: (from, to) => renameRetrying((a, b) => fs.rename(a, b), from, to, o),
    unlink: (p) => unlinkRetrying((q) => fs.unlink(q), p, o),
  };
}
