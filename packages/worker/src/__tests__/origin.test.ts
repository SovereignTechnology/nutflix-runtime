/**
 * The loopback NFX origin without a network (`../nfx/origin.ts`): over the NFX-05 test vector
 * video, it serves exactly NFX-05 §6's paths for the session's verified hash list (the ones a web
 * player asks for), with §6.1's caching and CORS headers, single ranges, HEAD and a preflight;
 * everything else is 404 (another token, another root, an unlisted hash, a query, uppercase hex,
 * dot segments, percent-encoding). Pull-through fetches a file once, forgets a failure, and is
 * bounded in time and in fetches at once; a stored video is served from the store.
 */
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { nfx } from '@sovit/core';
import type { NfxStoreFile } from '@sovit/seeder';
import { nodeFs, silentLogger } from '@sovit/seeder';
import { afterEach, describe, expect, it } from 'vitest';

import type { NfxOriginFilesOptions } from '../nfx/origin.js';
import { NfxOriginFiles, NfxOriginServer } from '../nfx/origin.js';
import type { NfxFetcher } from '../nfx/watch.js';
import { NfxFetchError } from '../nfx/watch.js';
import { httpGet, nodeHttpServer, request, sleep, tempDir } from './helpers/harness.js';
import { vectorVideo } from './helpers/nfx-video.js';
import type { VectorVideo } from './helpers/nfx-video.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const SID = 'a'.repeat(32);

interface CountingFetcher extends NfxFetcher {
  readonly asked: string[];
  /** Fetches of these shas wait until released (or the fetcher closes). */
  readonly hold: Set<string>;
  release(): void;
  /** Fetches of these fail. */
  readonly failing: Set<string>;
}

function fetcherOf(files: ReadonlyMap<string, Uint8Array>): CountingFetcher {
  const asked: string[] = [];
  const hold = new Set<string>();
  const failing = new Set<string>();
  const waiting: (() => void)[] = [];
  return {
    asked,
    hold,
    failing,
    release: () => {
      hold.clear();
      for (const w of waiting.splice(0)) w();
    },
    fetch: async (sha, size, exact) => {
      asked.push(sha);
      if (hold.has(sha))
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
        });
      if (failing.has(sha)) throw new NfxFetchError(['missing']);
      const b = files.get(sha);
      if (b === undefined || (exact ? b.length !== size : b.length > size))
        throw new NfxFetchError(['missing']);
      return b;
    },
    close: () => {
      for (const w of waiting.splice(0)) w();
      return Promise.resolve();
    },
  };
}

async function origin(
  v: VectorVideo,
  fetcher: NfxFetcher,
  over: Partial<NfxOriginFilesOptions> = {},
  waitMs?: number,
): Promise<{ base: string; files: NfxOriginFiles; server: NfxOriginServer; dir: string }> {
  const d = await tempDir('nf-origin-');
  cleanups.push(() => d.rm());
  const parsed = nfx.VideoAddr.parse(v.video);
  if (!parsed.ok) throw new Error('bad vector video');
  const dir = join(d.dir, 'o');
  const files = new NfxOriginFiles({
    video: parsed.value,
    root: v.root,
    list: v.list,
    listBytes: v.files.get(v.root)!,
    store: null,
    fetcher,
    fs: nodeFs,
    dir,
    logger: silentLogger,
    ...over,
  });
  const server = new NfxOriginServer({
    createHttpServer: nodeHttpServer,
    randomHex: (n) => randomBytes(n).toString('hex'),
    logger: silentLogger,
    ...(waitMs === undefined ? {} : { waitMs }),
  });
  cleanups.push(async () => {
    await files.close();
    await server.close();
  });
  await server.listen();
  return { base: server.register(SID, files), files, server, dir };
}

const shaOf = (v: VectorVideo, name: string): string => v.byName.get(name)!.sha256;

describe('NfxOriginServer + NfxOriginFiles', () => {
  it('serves the paths a web player asks for, byte for byte, with the §6 headers', async () => {
    const v = vectorVideo();
    const fetcher = fetcherOf(v.files);
    const { base } = await origin(v, fetcher);
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);

    const list = await httpGet(`${base}/${v.root}`);
    expect(list.status).toBe(200);
    expect(list.headers['content-type']).toBe('application/json');
    expect(list.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(list.headers['access-control-allow-origin']).toBe('*');
    expect(list.headers['x-content-type-options']).toBe('nosniff');
    expect(list.body.equals(Buffer.from(v.files.get(v.root)!))).toBe(true);

    const master = await httpGet(`${base}/${v.root}/master.m3u8`);
    expect(master.status).toBe(200);
    expect(master.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(master.body.equals(Buffer.from(v.files.get(shaOf(v, 'master.m3u8'))!))).toBe(true);

    const cases: [string, string, string][] = [
      ['r720.m3u8', 'm3u8', 'application/vnd.apple.mpegurl'],
      ['init-720.mp4', 'mp4', 'video/mp4'],
      ['seg0.m4s', 'm4s', 'video/iso.segment'],
      ['seg2.m4s', 'm4s', 'video/iso.segment'],
      ['thumb.jpg', 'jpg', 'application/octet-stream'],
    ];
    for (const [name, ext, type] of cases) {
      const sha = shaOf(v, name);
      const want = Buffer.from(v.files.get(sha)!);
      // Under the root (what playlist-relative URIs resolve to), and by hash alone (§6).
      for (const url of [
        `${base}/${v.root}/${sha}.${ext}`,
        `${base}/${sha}`,
        `${base}/${sha}.${ext}`,
      ]) {
        const r = await httpGet(url);
        expect(r.status, url).toBe(200);
        expect(r.headers['content-type'], url).toBe(type);
        expect(r.headers['content-length'], url).toBe(String(want.length));
        expect(r.body.equals(want), url).toBe(true);
      }
    }
    // Each file was fetched once, however often it was served (the hash list is never fetched).
    expect(new Set(fetcher.asked).size).toBe(fetcher.asked.length);
    expect(fetcher.asked).not.toContain(v.root);
  });

  it('HEAD, single ranges, 416, a preflight and 405', async () => {
    const v = vectorVideo();
    const { base } = await origin(v, fetcherOf(v.files));
    const sha = shaOf(v, 'init-720.mp4');
    const url = `${base}/${v.root}/${sha}.mp4`;
    const bytes = Buffer.from(v.files.get(sha)!);

    const head = await request(url, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers['content-length']).toBe(String(bytes.length));
    expect(head.headers['accept-ranges']).toBe('bytes');
    expect(head.body.length).toBe(0);

    const part = await httpGet(url, { range: 'bytes=2-9' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 2-9/${bytes.length}`);
    expect(part.body.equals(bytes.subarray(2, 10))).toBe(true);
    const tail = await httpGet(url, { range: 'bytes=-4' });
    expect(tail.body.equals(bytes.subarray(bytes.length - 4))).toBe(true);
    // p2p-media-loader resumes a segment with an open range.
    const resume = await httpGet(url, { range: 'bytes=10-' });
    expect(resume.status).toBe(206);
    expect(resume.body.equals(bytes.subarray(10))).toBe(true);

    for (const range of [`bytes=${bytes.length}-`, 'bytes=5-2', 'bytes=0-1,3-4', 'items=0-1']) {
      const r = await httpGet(url, { range });
      expect(r.status, range).toBe(416);
      expect(r.headers['content-range'], range).toBe(`bytes */${bytes.length}`);
      expect(r.headers['cache-control'], range).toBe('no-store');
    }

    const pre = await request(url, {
      method: 'OPTIONS',
      headers: { origin: 'null', 'access-control-request-headers': 'range' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers['access-control-allow-origin']).toBe('*');
    expect(pre.headers['access-control-allow-methods']).toBe('GET, HEAD');
    expect(pre.headers['access-control-allow-headers']).toBe('range');

    for (const method of ['POST', 'PUT', 'DELETE']) {
      const r = await request(url, { method });
      expect(r.status, method).toBe(405);
      expect(r.headers['allow'], method).toBe('GET, HEAD, OPTIONS');
    }
  });

  it('404 for everything else: no token, another token, root or hash; queries, dots, case', async () => {
    const v = vectorVideo();
    const fetcher = fetcherOf(v.files);
    const { base } = await origin(v, fetcher);
    const token = base.slice(base.lastIndexOf('/') + 1);
    const hostPort = base.slice(0, base.lastIndexOf('/'));
    const seg = shaOf(v, 'seg1.m4s');
    const other = 'e'.repeat(64);
    const urls = [
      `${hostPort}/${v.root}`,
      `${hostPort}/${v.root}/master.m3u8`,
      `${hostPort}/${'0'.repeat(32)}/${v.root}`,
      `${base}`,
      `${base}/`,
      `${base}/${other}`,
      `${base}/${other}/master.m3u8`,
      `${base}/${v.root}/${other}.m4s`,
      `${base}/${other}/${seg}.m4s`,
      `${base}/${seg}/master.m3u8`,
      `${base}/${v.root}.json/master.m3u8`,
      `${base}/${v.root}/${seg}`,
      `${base}/${v.root}/${seg}.m4s/`,
      `${base}/${v.root}/${seg}.toolongext`,
      `${base}/${v.root}/master.m3u8?x=1`,
      `${base}/${seg.toUpperCase()}`,
      `${base}/${v.root.toUpperCase()}/master.m3u8`,
      `${base.replace(token, token.toUpperCase())}/${v.root}`,
    ];
    for (const url of urls) {
      const r = await httpGet(url);
      expect(r.status, url).toBe(404);
      expect(r.headers['cache-control'], url).toBe('no-store');
      expect(r.headers['access-control-allow-origin'], url).toBe('*');
    }
    // Sent as written: dot segments, percent-encoding, doubled slashes, an absolute form.
    for (const path of [
      `/${token}/${v.root}/../${v.root}`,
      `/${token}/./${v.root}`,
      `/${token}/${v.root}/%2e%2e/${v.root}`,
      `/${token}/%2e%2e/${token}/${v.root}`,
      `/${token}//${v.root}`,
      `/${token}/${v.root}/master%2em3u8`,
      `${hostPort}/${token}/${v.root}`,
    ]) {
      const r = await request(base, { path });
      expect(r.status, path).toBe(404);
    }
    // Nothing was fetched for any of it.
    expect(fetcher.asked).toEqual([]);
  });

  it('pull-through: a failure is forgotten, a slow file is 503, fetches at once are bounded', async () => {
    const v = vectorVideo();
    const fetcher = fetcherOf(v.files);
    const { base, dir } = await origin(v, fetcher, { maxPulls: 1 }, 300);
    const seg0 = shaOf(v, 'seg0.m4s');
    const seg1 = shaOf(v, 'seg1.m4s');

    fetcher.failing.add(seg0);
    const failed = await httpGet(`${base}/${seg0}`);
    expect(failed.status).toBe(503);
    expect(failed.headers['cache-control']).toBe('no-store');
    fetcher.failing.clear();
    expect((await httpGet(`${base}/${seg0}`)).status).toBe(200);
    expect(fetcher.asked.filter((s) => s === seg0)).toHaveLength(2);
    // Spooled whole, never a `.part` left behind.
    expect(existsSync(join(dir, seg0))).toBe(true);
    expect(existsSync(join(dir, `${seg0}.part`))).toBe(false);

    // Held past the wait: 503, and the one pull slot is taken, so another file is 503 at once.
    fetcher.hold.add(seg1);
    expect((await httpGet(`${base}/${seg1}`)).status).toBe(503);
    const seg2 = shaOf(v, 'seg2.m4s');
    expect((await httpGet(`${base}/${seg2}`)).status).toBe(503);
    expect(fetcher.asked).not.toContain(seg2);
    // Released: the held pull lands, and a retry is served from the spool.
    fetcher.release();
    await sleep(50);
    const later = await httpGet(`${base}/${seg1}`);
    expect(later.status).toBe(200);
    expect(fetcher.asked.filter((s) => s === seg1)).toHaveLength(1);
  });

  it('a stored video is served from the store; unregister cuts and 404s', async () => {
    const v = vectorVideo();
    const fetcher = fetcherOf(new Map());
    const read: string[] = [];
    const store = {
      file: (_video: nfx.VideoAddr, sha: string): NfxStoreFile | undefined => {
        const b = v.files.get(sha);
        if (b === undefined) return undefined;
        return {
          size: b.length,
          read: (offset, length) => {
            read.push(sha);
            return Promise.resolve(b.subarray(offset, offset + length));
          },
        };
      },
    };
    const { base, server } = await origin(v, fetcher, { store });
    const sha = shaOf(v, 'r720.m3u8');
    const r = await httpGet(`${base}/${v.root}/${sha}.m3u8`);
    expect(r.status).toBe(200);
    expect(r.body.equals(Buffer.from(v.files.get(sha)!))).toBe(true);
    expect(read).toContain(sha);
    expect(fetcher.asked).toEqual([]);

    server.unregister(SID);
    expect((await httpGet(`${base}/${v.root}`)).status).toBe(404);
  });
});
