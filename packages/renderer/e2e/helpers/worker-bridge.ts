/**
 * Test support: the shell's half of the worker pipe. It runs the real worker (`WorkerHost` behind
 * `WorkerRpc`: real framing, real argument guards) in this process, on a node runtime (node:http
 * for its loopback servers, `@sovit/seeder`'s `nodeFs`), `init`s it on a throwaway directory and a
 * hyperdht testnet as a shell does before it hands a window the pipe, and carries frames between
 * it and a Playwright page as base64 (the page's `WorkerPipe`: `PAGE_PIPE_SCRIPT`).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Page } from 'playwright-core';

import { nodeFs } from '@sovit/seeder';
import type { BootstrapNode } from '@nutflix-runtime/worker';
import { WorkerHost } from '@nutflix-runtime/worker/host';
import { WorkerRpc } from '@nutflix-runtime/worker/rpc';
import type {
  HttpRequestHandler,
  HttpServerLike,
  WorkerRuntime,
} from '@nutflix-runtime/worker/runtime';

function nodeRuntime(): WorkerRuntime {
  return {
    fs: nodeFs,
    rmTree: (p) => rm(p, { recursive: true, force: true }),
    createHttpServer: (onRequest: HttpRequestHandler): Promise<HttpServerLike> =>
      Promise.resolve(
        http.createServer((req, res) => {
          onRequest(req, res);
        }),
      ),
  };
}

/**
 * Installed in the page before any of its scripts: `globalThis.nutflixWorkerPipe`, a `WorkerPipe`
 * whose bytes cross to Node through the exposed `__nfxPipeWrite`, and back through `__nfxPipePush`.
 * Also records every security-policy violation, for the test to read.
 */
export const PAGE_PIPE_SCRIPT = `(() => {
  const dataCbs = new Set();
  const closeCbs = new Set();
  const enc = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const dec = (b64) => { const s = atob(b64); const u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); return u8; };
  globalThis.__nfxPipePush = (b64) => { const u8 = dec(b64); for (const cb of [...dataCbs]) cb(u8); };
  globalThis.__nfxPipeEnd = () => { for (const cb of [...closeCbs]) cb(); };
  globalThis.nutflixWorkerPipe = {
    write(bytes) { globalThis.__nfxPipeWrite(enc(bytes)); },
    onData(cb) { dataCbs.add(cb); return () => { dataCbs.delete(cb); }; },
    onClose(cb) { closeCbs.add(cb); return () => { closeCbs.delete(cb); }; },
    close() {},
  };
  globalThis.__cspViolations = [];
  document.addEventListener('securitypolicyviolation', (e) => {
    globalThis.__cspViolations.push(e.effectiveDirective + ' ' + e.blockedURI);
  });
})();`;

export interface WorkerBridge {
  readonly host: WorkerHost;
  /** Connects `page` (before it navigates): binds the write side and starts carrying frames. */
  attach(page: Page): Promise<void>;
  close(): Promise<void>;
}

export async function startWorkerBridge(
  bootstrap: readonly BootstrapNode[],
): Promise<WorkerBridge> {
  const storage = mkdtempSync(join(tmpdir(), 'nutflix-e2e-worker-'));
  let attached: Page | null = null;
  // Frames to the page, in order: evaluate calls are made one after the other.
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
  const rpc: WorkerRpc = new WorkerRpc({
    write: toPage,
    handler: { handle: (m, a) => host.handle(m, a) },
    onFatal: (e) => {
      throw new Error(`the worker's pipe is corrupt: ${e.message}`);
    },
  });
  const host = new WorkerHost({
    runtime: nodeRuntime(),
    emit: (ev) => {
      rpc.emit(ev);
    },
    bootstrapWaitMs: 5000,
    dialTimeoutMs: 10_000,
  });
  // The shell's `init`: the storage directory and the bootstrap are its to name, never the page's.
  await host.handle('init', { v: 1, storage, bootstrap: [...bootstrap] });
  return {
    host,
    attach: async (page) => {
      attached = page;
      await page.exposeFunction('__nfxPipeWrite', (b64: string) => {
        rpc.push(new Uint8Array(Buffer.from(b64, 'base64')));
      });
      await page.addInitScript(PAGE_PIPE_SCRIPT);
    },
    close: async () => {
      attached = null;
      await chain;
      await host.close();
      rmSync(storage, { recursive: true, force: true });
    },
  };
}
