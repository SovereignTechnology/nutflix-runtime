/**
 * Test support (not a suite): the NFX videos the tests use, both nutflix-pear's own, from the
 * submodule (ADR 0001 §6: reuse, not copies).
 *
 *   - `testNfxVideo` (nutflix-pear `app-desktop/src/worker/__tests__/helpers/nfx-video.ts`): a
 *     tiny but valid fMP4 video, two renditions, and the layout C bytes a progressive stream
 *     must serve for it. It lists no master playlist.
 *   - `vectorVideo()`: the NFX-05 test vector (`docs/vendor/nfx-test-vectors/hashlist.json`, as
 *     core's `vectors.test.ts` reads it): a master playlist, a media playlist, an init, three
 *     segments and a thumbnail, fabricated bytes (not playable media), every one checked here
 *     against the hash list. What a web player asks an origin for.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nfx } from '@sovit/core';

export * from '../../../../../vendor/nutflix-pear/packages/app-desktop/src/worker/__tests__/helpers/nfx-video.js';

const VECTORS = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'vendor',
  'nutflix-pear',
  'docs',
  'vendor',
  'nfx-test-vectors',
);

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface VectorVideo {
  readonly video: string;
  readonly namespace: string;
  readonly root: string;
  readonly segs: number;
  readonly list: nfx.HashList;
  /** Every listed file by sha256, and the hash list under `root`. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  /** The listed files by name (`master.m3u8`, `r720.m3u8`, `init-720.mp4`, `seg0.m4s`, …). */
  readonly byName: ReadonlyMap<string, { readonly sha256: string; readonly role: nfx.Role }>;
}

interface WireFile {
  name: string;
  role: string;
  sha256: string;
  size: number;
  dur_ms?: number;
}
interface WireRendition {
  id: string;
  playlist: string;
  bandwidth: number;
  codecs?: string;
  resolution?: string;
}

/** The NFX-05 hash-list vector as a stored video: its rendered hash list and every file. */
export function vectorVideo(): VectorVideo {
  const v = JSON.parse(readFileSync(join(VECTORS, 'hashlist.json'), 'utf8')) as {
    rendered_bytes_sha256: string;
    hashlist: { video: string; files: WireFile[]; renditions: WireRendition[] };
    fabricated: Record<string, string>;
    playlists: Record<string, string>;
  };
  const list: nfx.HashList = {
    v: 1,
    video: v.hashlist.video,
    files: v.hashlist.files.map((f) => ({
      name: f.name,
      role: f.role as nfx.Role,
      sha256: f.sha256,
      size: BigInt(f.size),
      durMs: f.dur_ms === undefined ? undefined : BigInt(f.dur_ms),
    })),
    renditions: v.hashlist.renditions.map((r) => ({
      id: r.id,
      playlist: r.playlist,
      bandwidth: BigInt(r.bandwidth),
      codecs: r.codecs,
      resolution: r.resolution,
    })),
  };
  const listBytes = nfx.renderHashList(list);
  const root = sha256(listBytes);
  if (root !== v.rendered_bytes_sha256) throw new Error('the vector hash list does not render');
  const files = new Map<string, Uint8Array>([[root, listBytes]]);
  const blobs = [
    ...Object.values(v.fabricated).map((b64) => new Uint8Array(Buffer.from(b64, 'base64'))),
    ...Object.values(v.playlists).map((text) => new TextEncoder().encode(text)),
  ];
  for (const b of blobs) files.set(sha256(b), b);
  for (const f of list.files)
    if (files.get(f.sha256)?.byteLength !== Number(f.size))
      throw new Error(`the vector has no bytes for ${f.name}`);
  const at = v.hashlist.video.lastIndexOf(':');
  return {
    video: v.hashlist.video,
    namespace: v.hashlist.video.slice(0, at),
    root,
    segs: list.files.length,
    list,
    files,
    byName: new Map(list.files.map((f) => [f.name, { sha256: f.sha256, role: f.role }])),
  };
}
