/**
 * Test support: the built renderer (`dist/app`) served over loopback http, as a shell would serve
 * it from one origin. No headers of its own: the page's policy is its own `<meta>`.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

export async function serveDir(
  dir: string,
): Promise<{ readonly origin: string; close(): Promise<void> }> {
  const root = normalize(dir) + sep;
  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split(/[?#]/)[0] ?? '/';
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = normalize(join(dir, rel));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
