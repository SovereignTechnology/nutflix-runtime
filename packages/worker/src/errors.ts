/**
 * Errors as data on the host ⇄ worker wire: every failure crosses as a `WireError` (a code and a
 * short message starting `<code>: `) inside a response, and the receiving side rebuilds an
 * `Error` carrying `.code`, as nutflix-pear's `ipc/errors.ts` does. Only errors this package
 * raises keep their message; anything else becomes `internal: internal error`, so no path, stack
 * or peer data crosses by accident. `./rpc.ts` logs such a failure as `uncodedCause` gives it: a
 * code, a syscall and a class name, never the message.
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

/** `err`'s wire code, when it has one: a `WorkerError`, or a message starting `<code>: `. */
function wireCode(err: unknown): ErrorCode | null {
  if (err instanceof WorkerError) return err.code;
  if (err instanceof Error) {
    const code = PREFIX.exec(err.message)?.[1];
    if (isErrorCode(code)) return code;
  }
  return null;
}

/**
 * What crosses for `err`: a `WorkerError`'s code and message, a message that already starts
 * with a known `<code>: ` (the adapted nutflix-pear modules throw those), else `internal`.
 */
export function toWireError(err: unknown): WireError {
  const code = wireCode(err);
  if (code === null || !(err instanceof Error)) return INTERNAL;
  return { code, message: clamp(err.message) };
}

/**
 * What may be told of a failure that crosses as `internal` (see `uncodedCause`). Each field is
 * `null` when `err` has none, or one not shaped like one.
 */
export interface UncodedCause {
  /** An errno-style code: `EPERM`, `ERR_STREAM_PREMATURE_CLOSE`, `SESSION_CLOSED`. */
  readonly code: string | null;
  /** The system call that failed: `rename`, `open`, `rmdir` (bare-fs calls it `operation`). */
  readonly syscall: string | null;
  /** The error's class: `Error`, `TypeError`, `FileError`. */
  readonly name: string | null;
}

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{0,63}$/;
const SYSCALL_SHAPE = /^[a-z][a-z0-9_]{0,31}$/;
const NAME_SHAPE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

/** `o[key]`, only when it is a string of `shape`. A getter that throws reads as absent. */
function shaped(o: object, key: string, shape: RegExp): string | null {
  try {
    const v = (o as Record<string, unknown>)[key];
    return typeof v === 'string' && shape.test(v) ? v : null;
  } catch {
    return null;
  }
}

/**
 * For a failure with no wire code (it crosses as `internal`), the three things a log may say
 * about it: its `code`, `syscall` and `name`, each only when shaped like one. Never its message,
 * a path, or any other property: those can hold a file path or the user's data. `null` when `err`
 * has a wire code, whose own message already says what went wrong.
 */
export function uncodedCause(err: unknown): UncodedCause | null {
  if (wireCode(err) !== null) return null;
  if (typeof err !== 'object' || err === null) return { code: null, syscall: null, name: null };
  return {
    code: shaped(err, 'code', CODE_SHAPE),
    syscall: shaped(err, 'syscall', SYSCALL_SHAPE),
    name: shaped(err, 'name', NAME_SHAPE),
  };
}

/** The receiving side's error for a `WireError`. */
export function fromWireError(e: WireError): WorkerError {
  const detail = e.message.startsWith(`${e.code}: `)
    ? e.message.slice(e.code.length + 2)
    : e.message;
  return new WorkerError(e.code, detail);
}
