/**
 * Test support (not a suite): a small package of the playback clip's shape, in a new directory, as
 * `playback-clip.ts` writes one. Made-up bytes: the clip is checked and served here, never played.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderHashList, type FileEntry, type HashList, type Role } from '@sovit/core/nfx';

import { CLIP_FILE, CLIP_HEIGHT, CLIP_WIDTH, PLAY_NS, type ClipFile } from '../playback.ts';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** A small package of the clip's shape (made-up bytes: the clip is checked, not played, here). */
export function writeTestClip(tamper?: (files: Map<string, Uint8Array>) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'playback-clip-'));
  const video = `${PLAY_NS}:packaged-playback-test`;
  const init = utf8('init bytes');
  const segs = [utf8('segment zero'), utf8('segment one'), utf8('segment two')];
  const playlist = utf8(
    `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="${sha(init)}.mp4"\n${segs.map((s) => `#EXTINF:2.000,\n${sha(s)}.m4s`).join('\n')}\n#EXT-X-ENDLIST\n`,
  );
  const master = utf8(
    `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=320x240\n${sha(playlist)}.m3u8\n`,
  );
  const entry = (name: string, role: Role, b: Uint8Array, durMs?: bigint): FileEntry => ({
    name,
    role,
    sha256: sha(b),
    size: BigInt(b.length),
    durMs,
  });
  const entries = [
    entry('master.m3u8', 'playlist-master', master),
    entry('rvp9.m3u8', 'playlist', playlist),
    entry('init-vp9.mp4', 'init', init),
    ...segs.map((s, i) => entry(`vp9-${String(i)}.m4s`, 'segment', s, 2000n)),
  ];
  const list: HashList = {
    v: 1,
    video,
    files: entries,
    renditions: [
      {
        id: 'vp9',
        playlist: 'rvp9.m3u8',
        bandwidth: 100000n,
        codecs: undefined,
        resolution: '320x240',
      },
    ],
  };
  const listBytes = renderHashList(list);
  const files = new Map<string, Uint8Array>([[sha(listBytes), listBytes]]);
  for (const b of [master, playlist, init, ...segs]) files.set(sha(b), b);
  tamper?.(files);
  for (const [k, b] of files) writeFileSync(join(dir, k), b);
  const clip: ClipFile = {
    v: 1,
    video,
    root: sha(listBytes),
    segs: entries.length,
    durationSec: 20,
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
    files: [...files.keys()].sort(),
  };
  writeFileSync(join(dir, CLIP_FILE), JSON.stringify(clip));
  return dir;
}
