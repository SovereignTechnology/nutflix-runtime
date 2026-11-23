/**
 * The user's signer (ADR 0001 §8): a passphrase-sealed key held by this worker, or a NIP-46 bunker
 * whose session this worker holds. Electron's `safeStorage` is not used.
 *
 *   - **The key** is core's `LocalSigner`: made here, argon2id + XChaCha20-Poly1305 at rest
 *     (`<storage>/signer/user.key`, 0600), in sodium's secure memory while unlocked and zeroed by
 *     `lock`. No call returns it, and importing one is not offered: a key typed into a page would
 *     have been in the renderer. Someone with a key of their own uses a bunker.
 *   - **The passphrase** arrives over the pipe, is held as bytes only for the KDF and is wiped
 *     after it. The JavaScript string it arrived in cannot be wiped; nothing keeps a reference.
 *   - **Refusals:** a wrong passphrase costs a full KDF run, one at a time, and after the second
 *     failure an increasing wait, so a compromised page cannot grind through guesses.
 *   - Errors are this module's own words: never a passphrase, a URI or a library's message.
 */
import type { NostrEvent, NostrPubkey } from '@sovit/core';
import { signer as coreSigner } from '@sovit/core';
import type { SeederFs } from '@sovit/seeder';

import { WorkerError, fail } from '../errors.js';
import type { SignerStatusWire, UnsignedEventWire } from '../protocol.js';
import type { WorkerSystem } from '../runtime.js';
import { openBunker } from './bunker.js';

export const SIGNER_DIR = 'signer';
export const KEY_FILE = 'user.key';
const MAX_KEY_FILE_BYTES = 4096;

/** The wait after the `n`th failed unlock, ms: none for the first, then doubling to a minute. */
export function unlockBackoffMs(failures: number): number {
  if (failures < 2) return 0;
  return Math.min(60_000, 1000 * 2 ** (failures - 2));
}

export interface UserSignerDeps {
  readonly fs: SeederFs;
  readonly system: WorkerSystem;
  /** `<storage>/signer`. */
  readonly dir: string;
  readonly now?: () => number;
  /**
   * Whether this shell may hold a sealed key. `false` (shape b): no key file is read, made or
   * opened, and the only signer is a bunker.
   */
  readonly allowLocal: boolean;
  /** TESTS ONLY: the KDF's cost (default: libsodium MODERATE, core's `defaultCost`). */
  readonly cost?: coreSigner.KdfCost;
  /** TESTS ONLY: how long a bunker may take to answer. */
  readonly bunkerWaitMs?: number;
}

export class UserSigner {
  readonly #d: UserSignerDeps;
  readonly #file: string;
  #local: coreSigner.LocalSigner | null = null;
  #bunker: coreSigner.Nip46Signer | null = null;
  #bunkerKey: string | null = null;
  /** The public key the key file names (public data, readable without the passphrase). */
  #filePubkey: string | null = null;
  #busy = false;
  /** Bumped by `lock` and `close`: a signer still being opened then is not installed. */
  #generation = 0;
  /** Signatures in flight: the signer cannot be changed under one. */
  #signing = 0;
  #failures = 0;
  #notBefore = 0;

  constructor(d: UserSignerDeps) {
    this.#d = d;
    this.#file = d.fs.join(d.dir, KEY_FILE);
  }

  /** Read the key file's public header, if there is one. Never throws. */
  async load(): Promise<void> {
    if (!this.#d.allowLocal) return;
    try {
      const file = await this.#readFile();
      this.#filePubkey = file === null ? null : coreSigner.LocalSigner.pubkeyOf(file);
    } catch {
      // An unreadable or foreign file is no key; `create` still refuses to replace it.
      this.#filePubkey = null;
    }
  }

  status(): SignerStatusWire {
    const keyFile = this.#filePubkey !== null;
    if (this.#bunker !== null)
      return { kind: 'nip46', pubkey: this.#bunkerKey, locked: this.#bunker.isLocked(), keyFile };
    if (keyFile)
      return {
        kind: 'local',
        pubkey: this.#filePubkey,
        locked: this.#local?.isLocked() !== false,
        keyFile,
      };
    return { kind: 'none', pubkey: null, locked: true, keyFile };
  }

  /** The public key signatures will carry, when something can sign now. */
  get signingKey(): string | null {
    const s = this.status();
    return s.locked ? null : s.pubkey;
  }

  async create(passphrase: string): Promise<SignerStatusWire> {
    this.#needLocal();
    return this.#once(async () => {
      const generation = this.#generation;
      if ((await this.#exists()) || this.#filePubkey !== null)
        fail('exists', 'a key is already sealed on this machine');
      const pw = new TextEncoder().encode(passphrase);
      try {
        const { signer, file } = await coreSigner.LocalSigner.create({
          passphrase: pw,
          ...(this.#d.cost === undefined ? {} : { cost: this.#d.cost }),
        });
        try {
          await this.#d.system.writePrivate(this.#file, file);
        } catch {
          await signer.lock();
          fail('io', 'the key could not be saved');
        }
        this.#filePubkey = await signer.getPublicKey();
        if (generation === this.#generation) {
          await this.#dropSession();
          this.#local = signer;
        } else {
          await signer.lock();
        }
      } finally {
        pw.fill(0);
      }
      return this.status();
    });
  }

  async unlock(passphrase: string): Promise<SignerStatusWire> {
    this.#needLocal();
    return this.#once(async () => {
      const generation = this.#generation;
      const now = (this.#d.now ?? Date.now)();
      if (now < this.#notBefore) fail('rate-limited', 'too many wrong passphrases: wait a moment');
      const file = await this.#readFile();
      if (file === null) fail('no-signer', 'no key is sealed on this machine');
      const pw = new TextEncoder().encode(passphrase);
      try {
        const signer = await coreSigner.LocalSigner.unlock(file, pw);
        this.#filePubkey = await signer.getPublicKey();
        this.#failures = 0;
        this.#notBefore = 0;
        if (generation === this.#generation) {
          await this.#dropSession();
          this.#local = signer;
        } else {
          // "Lock" was pressed while this ran: it stays locked.
          await signer.lock();
        }
      } catch (e) {
        if (e instanceof coreSigner.KeyFileError && e.code === 'bad-passphrase') {
          this.#failures += 1;
          this.#notBefore = (this.#d.now ?? Date.now)() + unlockBackoffMs(this.#failures);
          fail('bad-passphrase', 'that passphrase does not open this key');
        }
        if (e instanceof WorkerError) throw e;
        fail('io', 'the key file could not be read');
      } finally {
        pw.fill(0);
      }
      return this.status();
    });
  }

  async connect(uri: string): Promise<SignerStatusWire> {
    return this.#once(async () => {
      const generation = this.#generation;
      const opened = await openBunker(uri, this.#d.system.connectRelay, this.#d.bunkerWaitMs);
      let adopted: coreSigner.Nip46Signer;
      try {
        adopted = await coreSigner.Nip46Signer.adopt(opened.bunker, opened.relays);
      } catch {
        await opened.bunker.close().catch(() => undefined);
        fail('no-signer', 'the bunker did not give a public key');
      }
      if (generation !== this.#generation) {
        await adopted.close().catch(() => undefined);
        return this.status();
      }
      await this.#dropSession();
      this.#bunker = adopted;
      this.#bunkerKey = await adopted.getPublicKey();
      return this.status();
    });
  }

  /** Zero a local key; close a bunker session. Idempotent. */
  async lock(): Promise<SignerStatusWire> {
    this.#notWhileSigning();
    this.#generation += 1;
    await this.#dropSession();
    return this.status();
  }

  /**
   * Sign `event` (the caller checked its kind). Only the fields of the request are signed, and
   * core's signers verify what comes back: a bunker that returns a different event is refused.
   */
  async sign(event: UnsignedEventWire): Promise<NostrEvent> {
    const signer = this.#bunker ?? this.#local;
    if (signer === null || signer.isLocked()) fail('no-signer', 'unlock or connect a signer first');
    this.#signing += 1;
    try {
      return await signer.signEvent({
        kind: event.kind,
        created_at: event.created_at,
        tags: event.tags.map((t) => [...t]),
        content: event.content,
      });
    } catch {
      fail('no-signer', 'the signer did not sign this event');
    } finally {
      this.#signing -= 1;
    }
  }

  async close(): Promise<void> {
    this.#generation += 1;
    await this.#dropSession();
  }

  async #dropSession(): Promise<void> {
    const local = this.#local;
    const bunker = this.#bunker;
    this.#local = null;
    this.#bunker = null;
    this.#bunkerKey = null;
    await local?.lock().catch(() => undefined);
    await bunker?.close().catch(() => undefined);
  }

  #needLocal(): void {
    if (!this.#d.allowLocal) fail('unsupported-input', 'this build signs through a bunker only');
  }

  #notWhileSigning(): void {
    if (this.#signing > 0) fail('rate-limited', 'a signature is pending');
  }

  /** One KDF or handshake at a time, and never under a signature in flight. */
  async #once<T>(f: () => Promise<T>): Promise<T> {
    this.#notWhileSigning();
    if (this.#busy) fail('rate-limited', 'the signer is busy');
    this.#busy = true;
    try {
      return await f();
    } finally {
      this.#busy = false;
    }
  }

  async #exists(): Promise<boolean> {
    return (await this.#d.fs.stat(this.#file)) !== null;
  }

  async #readFile(): Promise<Uint8Array | null> {
    const st = await this.#d.fs.stat(this.#file);
    if (st === null) return null;
    if (!st.isFile || st.size > MAX_KEY_FILE_BYTES) fail('io', 'the key file is not readable');
    return this.#d.fs.readFile(this.#file);
  }
}

export type { NostrPubkey };
