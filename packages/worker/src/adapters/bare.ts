/**
 * The Bare runtime for the worker: nutflix-pear's `app-desktop/src/worker/adapters/bare.ts` (the
 * submodule's pinned commit), cut to what this data plane uses — `bareSeederFs` and
 * `bareHttpServer` as they are there, plus `rmTree`. The state files, the ffmpeg runner, the
 * iroh helper and the DLEQ thread stay behind (Studio comes in a later step; iroh and the Rust
 * helper are not this app's, ADR 0001). The ONLY module that imports `bare-*` addons, which
 * cannot load under Node: `../main.ts` alone imports it.
 */
import type { FileStat, SeederFs } from '@sovit/seeder';
import fs from 'bare-fs';
import path from 'bare-path';

import type { HttpRequestHandler, HttpServerLike, WorkerRuntime } from '../runtime.js';

function errno(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** bare-fs types `readFile` as `string | Buffer`; without an encoding it is always a Buffer. */
function bytes(b: unknown): Uint8Array {
  if (!(b instanceof Uint8Array)) throw new TypeError('readFile returned text');
  return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
}

export const bareSeederFs: SeederFs = {
  readFile: async (p) => bytes(await fs.promises.readFile(p)),
  writeFile: (p, data) => fs.promises.writeFile(p, data),
  rename: (from, to) => fs.promises.rename(from, to),
  unlink: (p) => fs.promises.unlink(p),
  mkdir: async (p, opts) => {
    await fs.promises.mkdir(p, { recursive: opts?.recursive ?? false });
  },
  stat: async (p): Promise<FileStat | null> => {
    try {
      const s = await fs.promises.stat(p);
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
  },
  readStream: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  readRange: async (p, offset, length) => {
    if (length === 0) return new Uint8Array(0);
    const parts: Uint8Array[] = [];
    // `end` is inclusive (bare-fs `ReadStreamOptions`).
    const stream = fs.createReadStream(p, { start: offset, end: offset + length - 1 });
    for await (const chunk of stream as AsyncIterable<Uint8Array>) parts.push(chunk);
    let n = 0;
    for (const part of parts) n += part.byteLength;
    const out = new Uint8Array(n);
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.byteLength;
    }
    return out;
  },
  join: (...parts) => path.join(...parts),
};

/** Remove a directory tree; a missing one is fine. */
export async function bareRmTree(p: string): Promise<void> {
  await fs.promises.rm(p, { recursive: true, force: true });
}

/**
 * `WorkerRuntime.createHttpServer` on bare-http1 (nutflix-pear slice 5d), whose server, request
 * and response mirror node:http's — the shapes `../runtime.ts` names. Imported on the first
 * call, not at the top: it loads bare-tcp and bare-dns, native addons that cannot load under
 * Node.
 */
async function bareHttpServer(onRequest: HttpRequestHandler): Promise<HttpServerLike> {
  const http = (await import('bare-http1')).default;
  return http.createServer({}, (req, res) => {
    onRequest(req, res);
  });
}

export function bareRuntime(): WorkerRuntime {
  return {
    fs: bareSeederFs,
    rmTree: bareRmTree,
    createHttpServer: bareHttpServer,
  };
}
