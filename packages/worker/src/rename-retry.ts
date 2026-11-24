/**
 * A rename that rides out Windows' brief sharing violations, for every rename the worker makes
 * (its `SeederFs`, so the NFX store, `seeding.json` and the play spools too) and for the durable
 * writes of `./adapters/bare.ts`. Runtime-neutral: the caller names the platform (`Bare.platform`,
 * `process.platform`) and hands in the rename itself.
 *
 * On Windows, renaming over a file that another process holds open for a moment (Defender or the
 * search indexer, reading a file that was just written) fails with EPERM, EACCES or EBUSY, and the
 * same rename works a few milliseconds later. So on `win32`, and for those three codes only, it is
 * tried again, waiting 10 ms, then twice as long each time (at most 500 ms), until the waits would
 * pass `RENAME_RETRY_BUDGET_MS`; then the last error is thrown as it came. A file that is really
 * locked, or really forbidden, still fails, about three seconds later.
 *
 * Nothing else is retried: another code, or any code on another platform, where EPERM and EACCES
 * mean what they say, is thrown at once. Each attempt is the caller's whole rename, so a durable
 * write keeps its order: the temporary file synced, then the rename, then the directory synced.
 */
import type { SeederFs } from '@sovit/seeder';

/** What a sharing violation looks like on Windows: libuv's codes for it, from Node and bare-fs. */
export const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** The most it waits between attempts, in all. */
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

function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  try {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && TRANSIENT_RENAME_CODES.has(code);
  } catch {
    return false;
  }
}

/** `rename(from, to)`, tried again on Windows while it fails as a sharing violation. */
export async function renameRetrying(
  rename: (from: string, to: string) => Promise<void>,
  from: string,
  to: string,
  o: RenameRetryOptions,
): Promise<void> {
  if (o.platform !== 'win32') {
    await rename(from, to);
    return;
  }
  const sleep = o.sleep ?? wait;
  let waited = 0;
  let next = FIRST_WAIT_MS;
  for (;;) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (!isTransient(err) || waited + next > RENAME_RETRY_BUDGET_MS) throw err;
    }
    await sleep(next);
    waited += next;
    next = Math.min(next * 2, MAX_WAIT_MS);
  }
}

/** `fs` with its `rename` through `renameRetrying`. */
export function withRenameRetry(fs: SeederFs, o: RenameRetryOptions): SeederFs {
  return {
    ...fs,
    rename: (from, to) => renameRetrying((a, b) => fs.rename(a, b), from, to, o),
  };
}
