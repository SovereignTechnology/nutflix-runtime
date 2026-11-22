/**
 * Test-only: a `PlayWorker` that records every call and answers as the real worker's protocol
 * says (packages/worker/README.md), with a result or a failure a test scripts.
 */
import type { NfxPlayOpenArgs, NfxPlayOpenResult } from '@nutflix-runtime/worker';
import { WorkerError, type ErrorCode } from '@nutflix-runtime/worker';

import type { PlayWorker } from '../../worker/pipe.js';

export class FakeWorker implements PlayWorker {
  readonly opens: NfxPlayOpenArgs[] = [];
  readonly closes: string[] = [];
  readyCalls = 0;
  /** What `ready` does: resolve, or fail with this code. */
  readyFails: ErrorCode | null = null;
  /** What `open` does: answer with this result, or fail with this code. */
  openFails: ErrorCode | null = null;
  result: NfxPlayOpenResult = {
    progressiveUrl: `http://127.0.0.1:41234/${'a'.repeat(32)}/${'0'.repeat(31)}1`,
    originUrl: null,
    rendition: '720p',
    renditions: [
      { id: '720p', bandwidth: 2_000_000, resolution: '1280x720' },
      { id: '360p', bandwidth: 500_000, resolution: '640x360' },
    ],
  };
  closeFails = false;
  readonly #down = new Set<() => void>();

  ready(): Promise<void> {
    this.readyCalls += 1;
    return this.readyFails === null
      ? Promise.resolve()
      : Promise.reject(new WorkerError(this.readyFails, 'secret detail from the worker'));
  }

  open(args: NfxPlayOpenArgs): Promise<NfxPlayOpenResult> {
    this.opens.push(args);
    return this.openFails === null
      ? Promise.resolve(this.result)
      : Promise.reject(new WorkerError(this.openFails, 'secret detail from the worker'));
  }

  close(sid: string): Promise<void> {
    this.closes.push(sid);
    return this.closeFails
      ? Promise.reject(new WorkerError('backend-down', 'gone'))
      : Promise.resolve();
  }

  onDown(cb: () => void): () => void {
    this.#down.add(cb);
    return () => {
      this.#down.delete(cb);
    };
  }

  /** The worker's pipe ended. */
  goDown(): void {
    for (const cb of [...this.#down]) cb();
  }
}
