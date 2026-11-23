/**
 * The pinned nfx web library (`nfx-web.lock`), as the build takes it: the committed tar, refused
 * unless its sha256 is the lock's, read by a strict ustar reader (no `tar` program: the build runs
 * on every target, Windows included, and the reader takes nothing but regular files).
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface NfxLock {
  readonly commit: string;
  readonly srcSha256: string;
  readonly libSha256: string;
}

/** What the tar holds, exactly, in this order (nfx's `lib-tar.sh`). */
export const LIB_FILES = ['api.d.ts', 'player.d.ts', 'player.js', 'wasm/nfx_wasm_bg.wasm'] as const;

export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** The lock's one `nfx` line. Throws on anything else. */
export function parseLock(text: string): NfxLock {
  const lines = text.split('\n').filter((l) => l.startsWith('nfx '));
  if (lines.length !== 1) throw new Error('nfx-web.lock: there must be exactly one nfx line');
  const m = /^nfx ([0-9a-f]{40}) ([0-9a-f]{64}) ([0-9a-f]{64})$/.exec(lines[0] ?? '');
  if (m === null) throw new Error('nfx-web.lock: the nfx line is malformed');
  return { commit: m[1] ?? '', srcSha256: m[2] ?? '', libSha256: m[3] ?? '' };
}

const BLOCK = 512;

function field(h: Uint8Array, at: number, len: number): string {
  const raw = h.subarray(at, at + len);
  const end = raw.indexOf(0);
  return Buffer.from(end === -1 ? raw : raw.subarray(0, end)).toString('latin1');
}

/** A plain ustar archive's regular files, in order. Throws on anything else in it. */
export function readUstar(tar: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let at = 0;
  for (;;) {
    if (at + BLOCK > tar.length) throw new Error('tar: truncated');
    const h = tar.subarray(at, at + BLOCK);
    if (h.every((b) => b === 0)) return out;
    if (field(h, 257, 5) !== 'ustar') throw new Error('tar: not ustar');
    const stored = /^[0-7]+$/.exec(field(h, 148, 8).trim())?.[0];
    let sum = 8 * 0x20;
    for (let i = 0; i < BLOCK; i++) if (i < 148 || i >= 156) sum += h[i] ?? 0;
    if (stored === undefined || parseInt(stored, 8) !== sum) throw new Error('tar: bad checksum');
    const type = String.fromCharCode(h[156] ?? 0);
    if (type !== '0' && type !== '\0') throw new Error('tar: not a regular file');
    const prefix = field(h, 345, 155);
    const name = prefix === '' ? field(h, 0, 100) : `${prefix}/${field(h, 0, 100)}`;
    if (name === '' || name.startsWith('/') || name.split('/').includes('..')) {
      throw new Error('tar: unsafe name');
    }
    const size = /^[0-7]+$/.exec(field(h, 124, 12).trim())?.[0];
    if (size === undefined) throw new Error('tar: bad size');
    const bytes = parseInt(size, 8);
    const start = at + BLOCK;
    if (start + bytes > tar.length) throw new Error('tar: truncated file');
    if (out.has(name)) throw new Error('tar: duplicate name');
    out.set(name, tar.subarray(start, start + bytes));
    at = start + Math.ceil(bytes / BLOCK) * BLOCK;
  }
}

export interface PinnedLibrary {
  readonly lock: NfxLock;
  readonly playerJs: Uint8Array;
  readonly wasm: Uint8Array;
  readonly wasmSha256: string;
}

/** The library in `tar`, refused unless it is the pin. */
export function checkLibrary(lock: NfxLock, tar: Uint8Array): PinnedLibrary {
  const got = sha256Hex(tar);
  if (got !== lock.libSha256) {
    throw new Error(`the nfx library tar's sha256 is ${got}, not the lock's ${lock.libSha256}`);
  }
  const files = readUstar(tar);
  if (JSON.stringify([...files.keys()]) !== JSON.stringify(LIB_FILES)) {
    throw new Error(`the nfx library tar holds ${JSON.stringify([...files.keys()])}`);
  }
  const playerJs = files.get('player.js');
  const wasm = files.get('wasm/nfx_wasm_bg.wasm');
  if (playerJs === undefined || wasm === undefined) throw new Error('the tar lacks a file');
  return { lock, playerJs, wasm, wasmSha256: sha256Hex(wasm) };
}

/** The committed tar of the lock in package directory `pkg`, checked. */
export function readPinnedLibrary(pkg: string): PinnedLibrary {
  const lock = parseLock(readFileSync(join(pkg, 'nfx-web.lock'), 'utf8'));
  const tar = readFileSync(join(pkg, 'pinned', `nfx-web-lib-${lock.commit.slice(0, 12)}.tar`));
  return checkLibrary(lock, tar);
}

/** `nfx/wasm.js`: the verifier's bytes as one base64 string, the module's default export. */
export function wasmModuleSource(wasm: Uint8Array): string {
  return `export default "${Buffer.from(wasm).toString('base64')}";\n`;
}
