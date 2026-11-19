/**
 * Errors as data on the host ⇄ worker wire: every failure crosses as a `WireError` (a code and a
 * short message starting `<code>: `) inside a response, and the receiving side rebuilds an
 * `Error` carrying `.code`, as nutflix-pear's `ipc/errors.ts` does. Only errors this package
 * raises keep their message; anything else becomes `internal: internal error`, so no path, stack
 * or peer data crosses by accident.
 */
import type { ErrorCode, WireError } from './protocol.js';
import { ERROR_CODES } from './protocol.js';

/** The longest message that crosses. */
export const MAX_ERROR_MESSAGE = 512;

const CODES = new Set<string>(ERROR_CODES);
const PREFIX = /^([a-z][a-z0-9]*(?:-[a-z0-9]+)*): /;

export function isErrorCode(x: unknown): x is ErrorCode {
  return typeof x === 'string' && CODES.has(x);
}

/** A failure with a wire code; its message starts `<code>: `. */
export class WorkerError extends Error {
  override readonly name = 'WorkerError' as const;
  readonly code: ErrorCode;
  constructor(code: ErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

/** Throw a `WorkerError`. */
export function fail(code: ErrorCode, detail: string): never {
  throw new WorkerError(code, detail);
}

export const INTERNAL: WireError = { code: 'internal', message: 'internal: internal error' };

function clamp(s: string): string {
  const line = s.split(/\r?\n/, 1)[0] ?? '';
  return line.length <= MAX_ERROR_MESSAGE ? line : `${line.slice(0, MAX_ERROR_MESSAGE - 1)}…`;
}

/**
 * What crosses for `err`: a `WorkerError`'s code and message, a message that already starts
 * with a known `<code>: ` (the adapted nutflix-pear modules throw those), else `internal`.
 */
export function toWireError(err: unknown): WireError {
  if (err instanceof WorkerError) return { code: err.code, message: clamp(err.message) };
  if (err instanceof Error) {
    const code = PREFIX.exec(err.message)?.[1];
    if (isErrorCode(code)) return { code, message: clamp(err.message) };
  }
  return INTERNAL;
}

/** The receiving side's error for a `WireError`. */
export function fromWireError(e: WireError): WorkerError {
  const detail = e.message.startsWith(`${e.code}: `)
    ? e.message.slice(e.code.length + 2)
    : e.message;
  return new WorkerError(e.code, detail);
}
