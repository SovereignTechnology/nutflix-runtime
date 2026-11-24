/**
 * The Bare main of the pinned `pear run` shell (ADR 0001 shape b):
 *
 *   1. refuses any runtime but the exact Pear, Bare and platform version this build is pinned to;
 *   2. runs the same worker as shape (a), in this process, behind `PageGate`, watch only, and only
 *      when started from a versioned link (`../shared/link.ts`): from an unversioned one the window
 *      opens with no worker and says why;
 *   3. serves the page's files on a loopback origin (`page-server.ts`), not through `pear-bridge`;
 *   4. starts the Electron UI through `pear-electron`, whose fd-3 pipe is the page's only channel
 *      to the worker. No RPC listens on any socket.
 *
 * `init` names the storage directory and the DHT bootstrap: the page never does. The bootstrap
 * is the one the Pear sidecar runs on (`Pear.config.dht`), so a sidecar on a private DHT keeps the
 * worker there too, with no switch in the app.
 */
import http from 'bare-http1';
import hypercoreId from 'hypercore-id-encoding';
import PearElectron, { type UiPipe } from 'pear-electron';

import { WorkerHost } from '@nutflix-runtime/worker/host';
import { WorkerRpc } from '@nutflix-runtime/worker/rpc';

import { bareDataPlane } from '../../../../packages/worker/src/adapters/bare-data.js';
import { openCorestoreKeyring } from '../../../../packages/worker/src/keys.js';
import { linkKind } from '../shared/link.ts';
import { runtimeMismatch, type ReleaseLine } from '../shared/pins.ts';
import { dataPlaneOnly, watchOnlyRefusal } from './data-plane.ts';
import { PageGate } from './page-gate.ts';
import { PAGE_PORT_TRIES, pagePort } from './page-port.ts';
import { BASE_HEADERS, answerPageRequest } from './page-server.ts';
import { stderrWorkerLog } from './worker-log.ts';

/** Written in by `scripts/stage.ts`. */
declare const __PLATFORM_LINE__: ReleaseLine;
declare const __PAGE_FILES__: readonly string[];

const SHUTDOWN_GRACE_MS = 10_000;

function platformKey(raw: unknown): string | null {
  try {
    return hypercoreId.normalize(raw);
  } catch {
    return null;
  }
}

function listen(server: ReturnType<typeof http.createServer>, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const a = server.address();
      if (a === null || typeof a === 'string') reject(new Error('no loopback port'));
      else resolve(a.port);
    });
  });
}

function pageServer(ipc: PearIpc): {
  server: ReturnType<typeof http.createServer>;
  setHost: (h: string) => void;
} {
  const files = new Set(__PAGE_FILES__);
  let host = '';
  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
    const refuse = (status: number): void => {
      res.statusCode = status;
      res.setHeader('Content-Length', '0');
      res.end();
    };
    const headers = req.headers as Record<string, string | undefined>;
    const a = answerPageRequest(
      { method: req.method, url: req.url, host: headers['host'], xPear: headers['x-pear'] },
      files,
      host,
    );
    if (a.status !== 200) {
      refuse(a.status);
      return;
    }
    ipc.get({ key: `/page/${a.file}` }).then(
      (body) => {
        if (body === null) {
          refuse(404);
          return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', a.type);
        res.setHeader('Content-Length', String(body.byteLength));
        if (a.head) res.end();
        else res.end(body);
      },
      () => {
        refuse(500);
      },
    );
  });
  return {
    server,
    setHost: (h) => {
      host = h;
    },
  };
}

/** The page's server, on its stable port if it can have it (`page-port.ts`). */
async function listenPage(
  ipc: PearIpc,
  link: string,
): Promise<{ page: ReturnType<typeof pageServer>; port: number }> {
  for (let attempt = 0; attempt <= PAGE_PORT_TRIES; attempt++) {
    const page = pageServer(ipc);
    try {
      const want = attempt < PAGE_PORT_TRIES ? pagePort(link, attempt) : 0;
      const port = await listen(page.server, want);
      page.setHost(`127.0.0.1:${String(port)}`);
      return { page, port };
    } catch {
      // Taken: the next one.
    }
  }
  throw new Error('no loopback port for the page');
}

interface Worker {
  readonly gate: PageGate;
  close(): Promise<void>;
}

/**
 * The worker, in this process, watch only: no `system` (so no signer and no Studio), no sealed key,
 * nothing served (`watchOnly`), and the seeding switch off, which it must confirm.
 */
async function startWorker(
  toPage: (frame: Uint8Array) => void,
  closePage: () => void,
): Promise<Worker> {
  const gate: PageGate = new PageGate({
    toWorker: (frame) => {
      rpc.push(frame);
    },
    toPage,
    closePage,
  });
  const rpc: WorkerRpc = new WorkerRpc({
    write: (bytes) => {
      gate.fromWorker(bytes);
    },
    handler: { handle: (m, a) => host.handle(m, a) },
    onFatal: () => {
      gate.workerGone();
      Bare.exit(3);
    },
    // A request that failed with no code: its method, code, syscall and class, on this process's
    // stderr. The page gate passes no `log` event to the page, and must not.
    log: stderrWorkerLog((line) => {
      console.error(line);
    }),
  });
  const host: WorkerHost = new WorkerHost({
    runtime: dataPlaneOnly(bareDataPlane()),
    emit: (ev) => {
      rpc.emit(ev);
    },
    openKeyring: openCorestoreKeyring,
  });
  const storage = `${Pear.config.storage}/worker`;
  await gate.request('init', {
    v: 1,
    storage,
    bootstrap: Pear.config.dht?.bootstrap ?? null,
    // No passphrase-sealed key: this window has no safe place to type one (ADR 0001 amendment).
    localKey: false,
    // Nothing stored is served and no listener opens, not even for a video an earlier run seeded.
    watchOnly: true,
  });
  // The "seed what you watch" switch, off whatever a file on disk says. A worker that does not
  // confirm it does not get a window.
  await gate.request('seeding.set', { watched: false });
  const refusal = watchOnlyRefusal(await gate.request('seeding.status', {}), storage);
  if (refusal !== null) {
    console.error(`nutflix: refusing to start: ${refusal}.`);
    Bare.exit(1);
  }
  return { gate, close: () => host.close() };
}

export async function main(): Promise<void> {
  const versions = await Pear.versions();
  const mismatch = runtimeMismatch(
    versions,
    platformKey(versions.platform?.key),
    __PLATFORM_LINE__,
  );
  if (mismatch !== null) {
    console.error(
      `nutflix: refusing to start: ${mismatch}. This build runs only on its pinned Pear v2.6.5 release line.`,
    );
    Bare.exit(1);
  }

  const ipc = (Pear as unknown as Record<symbol, PearIpc>)[Pear.constructor.IPC];
  if (ipc === undefined) throw new Error('this Pear has no IPC');

  // A rejection nothing handled would abort Bare: as in the worker's own entry, it is survived.
  Bare.on('unhandledRejection', () => {
    console.error('nutflix: an unhandled rejection in the worker');
  });

  let pipe: UiPipe | null = null;
  const refused = linkKind(Pear.config.link) === 'unversioned';
  if (refused)
    console.error(
      'nutflix: refusing to start the worker: this is an unversioned link, which Pear v2 updates with no signed notice. Run the versioned link the release notice names.',
    );
  const worker = refused
    ? null
    : await startWorker(
        (frame) => {
          pipe?.write(frame);
        },
        () => {
          pipe?.destroy();
        },
      );

  const { page, port } = await listenPage(ipc, Pear.config.link ?? Pear.config.storage);

  let stopping = false;
  const stop = (code: number): void => {
    if (stopping) return;
    stopping = true;
    worker?.gate.pageGone();
    const force = setTimeout(() => {
      Bare.exit(code);
    }, SHUTDOWN_GRACE_MS);
    page.server.close();
    void (worker?.close() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        Bare.exit(code);
      });
  };
  Pear.teardown(() => {
    stop(0);
  });

  const ui = await new PearElectron().start({
    bridge: { addr: `http://127.0.0.1:${String(port)}` },
  });
  pipe = ui;
  ui.on('data', (chunk) => {
    worker?.gate.fromPage(chunk);
  });
  ui.on('end', () => {
    stop(0);
  });
  ui.on('close', () => {
    stop(0);
  });
  ui.on('error', () => {
    stop(1);
  });
}
