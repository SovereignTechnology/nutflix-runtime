/**
 * Test support: what the Electron main process does, minus Electron. The REAL worker, built, under
 * the REAL Bare runtime (`bare-sidecar`'s prebuilt, as `pear-runtime` starts it), behind the REAL
 * gate (`shells/pear-v3/src/main/rpc-gate.ts`, the window's real policy) and the real answers to
 * the two main-only methods (`main-calls.ts`). Only the native dialogs are scripted, and the page's
 * `WorkerPipe` is a Playwright bridge instead of a preload.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from 'playwright-core';
import Sidecar from 'bare-sidecar';

import type { BootstrapNode } from '@nutflix-runtime/worker';

import { answerMainCall } from '../../../../shells/pear-v3/src/main/main-calls.ts';
import { MAIN_WINDOW_POLICY, RpcGate } from '../../../../shells/pear-v3/src/main/rpc-gate.ts';
import { PAGE_PIPE_SCRIPT } from '../helpers/worker-bridge.js';

const here = dirname(fileURLToPath(import.meta.url));
export const WORKER_MAIN = join(here, '..', '..', '..', 'worker', 'dist', 'main.js');

const WINDOW = 1;

export interface BareBridge {
  /** The worker's storage directory, which only main knows. */
  readonly storage: string;
  /** What the native dialogs will answer. */
  readonly dialogs: { file: string | null; confirmSeeding: boolean; asked: number };
  attach(page: Page): Promise<void>;
  /** Main's own request. */
  request(m: string, a: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  stderr(): string;
  close(): Promise<void>;
}

export async function startBareBridge(bootstrap: readonly BootstrapNode[]): Promise<BareBridge> {
  const storage = join(mkdtempSync(join(tmpdir(), 'nutflix-publish-')), 'worker');
  const sidecar = new Sidecar(WORKER_MAIN);
  let err = '';
  sidecar.stderr?.on('data', (c: unknown) => {
    if (c instanceof Uint8Array) err = (err + Buffer.from(c).toString('utf8')).slice(-8000);
  });
  sidecar.stdout?.resume();
  sidecar.on('error', () => undefined);
  const exited = new Promise<void>((resolve) => {
    sidecar.once('exit', () => {
      resolve();
    });
  });

  let attached: Page | null = null;
  let chain: Promise<void> = Promise.resolve();
  const toPage = (bytes: Uint8Array): void => {
    const b64 = Buffer.from(bytes).toString('base64');
    chain = chain
      .then(async () => {
        const page = attached;
        if (page === null || page.isClosed()) return;
        await page.evaluate((b) => {
          (globalThis as unknown as { __nfxPipePush: (s: string) => void }).__nfxPipePush(b);
        }, b64);
      })
      .catch(() => undefined);
  };

  const dialogs = { file: null as string | null, confirmSeeding: false, asked: 0 };
  const gate: RpcGate = new RpcGate({
    toWorker: (frame) => {
      sidecar.write(frame);
    },
    toWindow: (_id, frame) => {
      toPage(frame);
    },
    closeWindow: () => undefined,
    mainCall: (_id, method, args) =>
      answerMainCall(method, args, {
        pickFile: () => {
          dialogs.asked += 1;
          return Promise.resolve(dialogs.file);
        },
        confirmSeeding: () => {
          dialogs.asked += 1;
          return Promise.resolve(dialogs.confirmSeeding);
        },
        worker: (m, a) => gate.request(m, a),
      }),
  });
  sidecar.on('data', (c: unknown) => {
    if (c instanceof Uint8Array) gate.fromWorker(c);
  });
  sidecar.once('exit', () => {
    gate.workerGone();
  });
  // Main's `init`: the storage directory and the bootstrap are its to name, never the page's.
  await gate.request('init', { v: 1, storage, bootstrap: [...bootstrap] }, 60_000);

  return {
    storage,
    dialogs,
    attach: async (page) => {
      attached = page;
      gate.attach(WINDOW, MAIN_WINDOW_POLICY);
      await page.exposeFunction('__nfxPipeWrite', (b64: string) => {
        gate.fromWindow(WINDOW, new Uint8Array(Buffer.from(b64, 'base64')));
      });
      await page.addInitScript(PAGE_PIPE_SCRIPT);
    },
    request: (m, a, timeoutMs) => gate.request(m, a, timeoutMs),
    stderr: () => err,
    close: async () => {
      attached = null;
      await chain;
      gate.detach(WINDOW);
      // EOF on the worker's pipe: it closes everything and exits.
      (sidecar as unknown as { readonly _ipc: { end(): void } })._ipc.end();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
      sidecar.destroy();
      rmSync(dirname(storage), { recursive: true, force: true });
    },
  };
}
