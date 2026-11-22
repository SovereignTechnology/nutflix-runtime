/**
 * How the renderer's adapter fails: an `Error` whose `message` starts with `"<code>: "` and which
 * carries `.code`, the two things the screens classify by. Adapted from nutflix-pear's
 * `packages/app-web/src/errors.ts` (the submodule's pinned commit); `worker-down` is new.
 *
 * Messages never carry a relay's, a peer's or the worker's own words, only what this client
 * decided: a remote or worker-supplied string is never shown as an error.
 */

export type RuntimeErrorCode =
  /** A call this slice does not serve (no wallet, signer, Studio or seeding yet). */
  | 'unsupported'
  | 'invalid-argument'
  | 'not-found'
  /** Nobody seeding the video named a HyperDHT endpoint this client can use (the screens' prefix). */
  | 'no-seeders'
  /** No relay answered (the screens' prefix). */
  | 'relay-down'
  /** The worker did not answer, or its pipe closed. */
  | 'worker-down'
  /** Refused by this client's rules, e.g. an image whose sha256 nobody signed. */
  | 'forbidden'
  | 'session-closed'
  | 'internal';

export class RuntimeAdapterError extends Error {
  override readonly name = 'RuntimeAdapterError' as const;
  readonly code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** Throws a `RuntimeAdapterError`. */
export function fail(code: RuntimeErrorCode, detail: string): never {
  throw new RuntimeAdapterError(code, detail);
}

/** A promise rejected with a `RuntimeAdapterError`. */
export function rejectWith<T = never>(code: RuntimeErrorCode, detail: string): Promise<T> {
  return Promise.reject(new RuntimeAdapterError(code, detail));
}

/** A call this slice does not offer (and whose screen or action the offer hides). */
export function unsupported<T = never>(what: string): Promise<T> {
  return rejectWith('unsupported', `${what} is not available in this version`);
}
