/**
 * An `NfxFetcher` over this node's own NFX store: a video it seeds plays without the network.
 * Only the files the stored video's verified hash list names (the store's own rule), each read
 * whole in pieces the store allows and hashed again before it is handed over: the store checked
 * the bytes when it wrote them, this checks the disk still holds them (NFX-05 §4).
 */
import type { nfx } from '@sovit/core';
import type { NfxStoreFile, SeederCrypto } from '@sovit/seeder';
import { NFX_MAX_READ_BYTES } from '@sovit/seeder';

import type { NfxFetcher } from './watch.js';
import { NfxFetchError } from './watch.js';

/** The part of `NfxStore` read here. */
export interface NfxLocalFiles {
  file(video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined;
}

export interface StoreFetcherOptions {
  readonly files: NfxLocalFiles;
  readonly video: nfx.VideoAddr;
  readonly crypto: SeederCrypto;
}

export class StoreFetcher implements NfxFetcher {
  private readonly o: StoreFetcherOptions;
  private closed = false;

  constructor(o: StoreFetcherOptions) {
    this.o = o;
  }

  async fetch(sha: string, size: number, exact: boolean): Promise<Uint8Array> {
    if (this.closed) throw new NfxFetchError(['closed']);
    const file = this.o.files.file(this.o.video, sha);
    if (file === undefined) throw new NfxFetchError(['not-stored']);
    if (exact ? file.size !== size : file.size > size) throw new NfxFetchError(['stored-size']);
    const out = new Uint8Array(file.size);
    const hash = this.o.crypto.createSha256();
    try {
      for (let at = 0; at < file.size; at += NFX_MAX_READ_BYTES) {
        const piece = await file.read(at, Math.min(NFX_MAX_READ_BYTES, file.size - at));
        if (this.isClosed()) throw new NfxFetchError(['closed']);
        out.set(piece, at);
        hash.update(piece);
      }
    } catch (err) {
      if (err instanceof NfxFetchError) throw err;
      throw new NfxFetchError(['store-read']);
    }
    if (hash.digestHex() !== sha) throw new NfxFetchError(['store-mismatch']);
    return out;
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }

  /** Read fresh after an `await`. */
  private isClosed(): boolean {
    return this.closed;
  }
}
