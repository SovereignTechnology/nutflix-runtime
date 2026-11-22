/**
 * One free NFX play over HyperDHT: the worker's progressive stream as a plain `<video src>`.
 * ADR 0001 decision 4's fallback path, and in this slice the only one. The source is a `url`
 * source (the desktop app's own), so the screen sets `src` itself; closing the session closes the
 * worker's play, which cuts the loopback stream, stops its fetches and deletes its spool.
 *
 * Renditions are fixed when the worker answers `nfx.play.open`: it plays one of them, and
 * switching is closing this session and opening another (`playNfx(addr, id)`), as before
 * `setRendition` existed (`NfxPlaySession`'s contract).
 */
import type { NfxAddress, NfxPlaySession, NfxRenditionInfo, PlaySource } from '@sovit/core';

import type { PlayWorker } from '../worker/pipe.js';

export interface RuntimeNfxSessionOptions {
  readonly videoId: NfxAddress;
  /** The worker's session name (`nfx.play.open`'s `sid`). */
  readonly sid: string;
  /** `http://127.0.0.1:<port>/<token>/<sid>`, already checked (`isWorkerMediaUrl`). */
  readonly url: string;
  readonly rendition: string;
  readonly renditions: readonly NfxRenditionInfo[];
  readonly worker: Pick<PlayWorker, 'close'>;
  /** Told once, when the session closes. */
  readonly onClose?: ((s: RuntimeNfxSession) => void) | undefined;
}

export class RuntimeNfxSession implements NfxPlaySession {
  readonly videoId: NfxAddress;
  readonly rendition: string;
  readonly renditions: readonly NfxRenditionInfo[];
  readonly source: PlaySource;
  readonly sid: string;
  readonly #o: RuntimeNfxSessionOptions;
  #closed: Promise<void> | null = null;

  constructor(o: RuntimeNfxSessionOptions) {
    this.#o = o;
    this.videoId = o.videoId;
    this.sid = o.sid;
    this.rendition = o.rendition;
    this.renditions = o.renditions;
    this.source = { kind: 'url', url: o.url };
  }

  get closed(): boolean {
    return this.#closed !== null;
  }

  /** Idempotent. A worker that is gone has closed the play already: that is not an error. */
  close(): Promise<void> {
    this.#closed ??= (async (): Promise<void> => {
      this.#o.onClose?.(this);
      try {
        await this.#o.worker.close(this.sid);
      } catch {
        // `nfx.play.close` is idempotent, and a down worker holds no session.
      }
    })();
    return this.#closed;
  }
}
