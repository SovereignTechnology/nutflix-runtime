/**
 * Test support: a real, playable NFX-05 package made with ffmpeg, in VP9 so that any Chromium
 * plays it (the open-source builds Playwright installs have no H.264). `core`'s own packager
 * (`media.packageNfx`) refuses anything but H.264; this is its same steps for a VP9 rendition:
 * ffmpeg's CMAF remux (`media.cmafRemuxArgv`, core's own arguments), every file named by its
 * sha256, the playlists rewritten to content names, a master playlist and the hash list, then the
 * package checked as a consumer would (`verifyHashList`, `verifyFile`, `checkPlaylist`).
 *
 * The clip is ffmpeg's `testsrc`: a counter, so a frame that plays is a frame that moved.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { media } from '@sovit/core';
import {
  VideoAddr,
  checkPlaylist,
  renderHashList,
  verifyFile,
  verifyHashList,
  type FileEntry,
  type HashList,
} from '@sovit/core/nfx';

export interface Vp9Package {
  readonly video: string;
  readonly root: string;
  readonly segs: number;
  /** Every file by sha256, the hash list under `root` among them. */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly durationSec: number;
}

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const utf8 = new TextEncoder();

function ffmpeg(args: readonly string[]): void {
  const bin = process.env['FFMPEG'] ?? 'ffmpeg';
  const r = spawnSync(bin, [...args], { encoding: 'utf8' });
  if (r.error !== undefined || r.status !== 0) {
    throw new Error(
      `ffmpeg ${args.slice(0, 3).join(' ')}… failed (${r.error?.message ?? String(r.status)}): ${r.stderr.slice(-400)}`,
    );
  }
}

/** `seconds` of 320x240 `testsrc`, VP9, a key frame every 2 s (core's GOP), as NFX `video`. */
export function makeVp9Package(video: string, seconds = 10): Vp9Package {
  const dir = mkdtempSync(join(tmpdir(), 'nutflix-e2e-'));
  try {
    const src = join(dir, 'source.mp4');
    ffmpeg([
      '-hide_banner',
      '-nostdin',
      '-y',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `testsrc=size=320x240:rate=25:duration=${String(seconds)}`,
      '-c:v',
      'libvpx-vp9',
      '-b:v',
      '150k',
      '-deadline',
      'realtime',
      '-cpu-used',
      '8',
      '-g',
      '50',
      '-keyint_min',
      '50',
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-pix_fmt',
      'yuv420p',
      '-an',
      src,
    ]);
    const out = join(dir, 'cmaf');
    mkdirSync(out);
    ffmpeg([...media.cmafRemuxArgv(src, out)]);

    const init = readFileSync(join(out, 'init.mp4'));
    const initSha = sha(init);
    const label = 'vp9';
    const files: { entry: FileEntry; bytes: Uint8Array }[] = [
      {
        entry: {
          name: `init-${label}.mp4`,
          role: 'init',
          sha256: initSha,
          size: BigInt(init.length),
          durMs: undefined,
        },
        bytes: init,
      },
    ];
    const text = readFileSync(join(out, 'index.m3u8'), 'utf8');
    const lines: string[] = [];
    let pendingMs: number | undefined;
    let peakBps = 0n;
    let totalMs = 0;
    for (const line of text.split('\n').map((l) => l.replace(/\r$/, ''))) {
      if (line === '' && lines.length === 0) continue;
      if (line.startsWith('#EXT-X-MAP:')) {
        lines.push(`#EXT-X-MAP:URI="${initSha}.mp4"`);
      } else if (line.startsWith('#EXTINF:')) {
        pendingMs = Math.round(Number(line.slice(8).split(',')[0] ?? '0') * 1000);
        lines.push(line);
      } else if (line !== '' && !line.startsWith('#')) {
        if (pendingMs === undefined || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(line)) {
          throw new Error(`unexpected playlist line ${line}`);
        }
        const bytes = readFileSync(join(out, line));
        const h = sha(bytes);
        const ms = BigInt(pendingMs);
        const bps = (BigInt(bytes.length) * 8000n + ms - 1n) / ms;
        if (bps > peakBps) peakBps = bps;
        totalMs += pendingMs;
        files.push({
          entry: {
            name: `${label}-${line}`,
            role: 'segment',
            sha256: h,
            size: BigInt(bytes.length),
            durMs: ms,
          },
          bytes,
        });
        lines.push(`${h}.m4s`);
        pendingMs = undefined;
      } else if (line !== '') {
        lines.push(line);
      }
    }
    if (files.length < 3 || !text.includes('#EXT-X-ENDLIST'))
      throw new Error('ffmpeg wrote no usable playlist');
    const playlist = utf8.encode(`${lines.join('\n')}\n`);
    const playlistName = `r${label}.m3u8`;
    const master = utf8.encode(
      `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=${peakBps.toString()},RESOLUTION=320x240,CODECS="vp09.00.10.08"\n${sha(playlist)}.m3u8\n`,
    );
    const all = [
      {
        entry: {
          name: 'master.m3u8',
          role: 'playlist-master',
          sha256: sha(master),
          size: BigInt(master.length),
          durMs: undefined,
        } as FileEntry,
        bytes: master,
      },
      {
        entry: {
          name: playlistName,
          role: 'playlist',
          sha256: sha(playlist),
          size: BigInt(playlist.length),
          durMs: undefined,
        } as FileEntry,
        bytes: playlist,
      },
      ...files,
    ];
    const addr = VideoAddr.parse(video);
    if (!addr.ok) throw new Error(`bad video address ${video}`);
    const list: HashList = {
      v: 1,
      video,
      files: all.map((f) => f.entry),
      renditions: [
        {
          id: label,
          playlist: playlistName,
          bandwidth: peakBps,
          codecs: 'vp09.00.10.08',
          resolution: '320x240',
        },
      ],
    };
    const listBytes = renderHashList(list);
    const root = sha(listBytes);
    const verified = verifyHashList(listBytes, root, addr.value, BigInt(all.length));
    if (!verified.ok) throw new Error(`hash list: ${verified.error.reason}`);
    for (const f of all) {
      const ok = verifyFile(f.entry.sha256, f.bytes);
      if (!ok.ok) throw new Error(`${f.entry.name}: ${ok.error.reason}`);
      if (f.entry.role === 'playlist' || f.entry.role === 'playlist-master') {
        const p = checkPlaylist(verified.value, f.bytes);
        if (!p.ok) throw new Error(`${f.entry.name}: ${p.error.reason}`);
      }
    }
    const map = new Map<string, Uint8Array>([[root, listBytes]]);
    for (const f of all) map.set(f.entry.sha256, f.bytes);
    return { video, root, segs: all.length, files: map, durationSec: totalMs / 1000 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
