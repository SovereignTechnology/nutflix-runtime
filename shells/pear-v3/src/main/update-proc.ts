/**
 * Main's side of the updater process (`src/update/update-worker.ts`). Main starts it only for a
 * build packaged with an upgrade link, tells it where things are, and reads status frames. A frame
 * that does not parse ends the process: the app keeps running, on the build it has.
 *
 * Main holds no update decision and has no way to ask for an apply. It passes on a checked status,
 * through `RpcGate.fromMain`, for the renderer to display.
 */
import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import type { SidecarLike } from 'pear-runtime';

import { parseUpdateStatus, type UpdateStart, type UpdateStatus } from '../update/status.ts';
import type { Fields } from './log.ts';
import { startWorker, type WorkerHandle } from './worker-proc.ts';

/** A status is a few fixed words. */
export const MAX_STATUS_FRAME = 1024;

export interface UpdaterDeps {
  readonly entry: string;
  run(entry: string, args: readonly string[]): SidecarLike;
  readonly start: UpdateStart;
  onStatus(s: UpdateStatus): void;
  log(name: string, fields?: Fields): void;
}

export function startUpdater(d: UpdaterDeps): WorkerHandle {
  let handle: WorkerHandle | null = null;
  const refuse = (): void => {
    d.log('update-worker-corrupt');
    handle?.stop();
  };
  const decoder = new FrameDecoder(
    (msg) => {
      const m = msg as Record<string, unknown>;
      const status = m['op'] === 'status' ? parseUpdateStatus(m['status']) : null;
      if (status === null) refuse();
      else d.onStatus(status);
    },
    { maxFrameBytes: MAX_STATUS_FRAME },
  );
  handle = startWorker({
    entry: d.entry,
    run: (entry, args) => d.run(entry, args),
    gate: {
      fromWorker: (bytes) => {
        try {
          decoder.push(bytes);
        } catch {
          refuse();
        }
      },
      workerGone: () => undefined,
    },
    // Its names are its own: the data worker's `worker-exit` means a broken app, this does not.
    log: (name, fields) => {
      d.log(name.replace(/^worker-/, 'update-worker-'), fields);
    },
  });
  handle.write(encodeFrame({ op: 'start', start: d.start }));
  return handle;
}

/** What this install is, for the updater: `null` when it is not an installed package. */
export function installedApp(o: {
  readonly platform: string;
  readonly arch: string;
  readonly execPath: string;
  /** `process.env.APPIMAGE`: the AppImage runtime's own path, set by that runtime. */
  readonly appImage: string | undefined;
  /** `process.windowsStore`: this process runs from an installed MSIX package. */
  readonly windowsStore: boolean;
  readonly productName: string;
}): { readonly name: string; readonly app: string; readonly host: string } | null {
  const host = `${o.platform}-${o.arch}`;
  if (o.platform === 'linux') {
    const name = `${o.productName}.AppImage`;
    const p = o.appImage;
    if (p?.startsWith('/') !== true || !p.endsWith(`/${name}`)) return null;
    return { name, app: p, host };
  }
  if (o.platform === 'darwin') {
    const tail = `/${o.productName}.app/Contents/MacOS/${o.productName}`;
    if (!o.execPath.endsWith(tail)) return null;
    return {
      name: `${o.productName}.app`,
      app: o.execPath.slice(0, -'/Contents/MacOS/'.length - o.productName.length),
      host,
    };
  }
  if (o.platform === 'win32' && o.windowsStore)
    return { name: `${o.productName}.msix`, app: o.execPath, host };
  return null;
}
