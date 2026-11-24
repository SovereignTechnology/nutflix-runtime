/**
 * The packaged-playback proof's test video (`playback.ts`): ffmpeg's `testsrc`, a counter, as a real
 * VP9 NFX package, made with the renderer e2e's own maker (`packages/renderer/e2e/helpers/vp9-nfx.ts`)
 * and written out for the install job. It runs once, on Linux, in the `playback-clip` job: the macOS
 * and Windows runners have no ffmpeg. The install job checks every file against the hash list before
 * it seeds one (`loadClip`), so this directory is data, never trusted.
 *
 *   node scripts/pear-ci/playback-clip.ts --out <dir>
 *
 * `<dir>/clip.json` names the video, its hash list (`root`), its file count, its duration and frame
 * size; every file of the package is `<dir>/<sha256>`, the hash list among them.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeVp9Package } from '../../../../packages/renderer/e2e/helpers/vp9-nfx.ts';
import {
  CLIP_FILE,
  CLIP_HEIGHT,
  CLIP_SECONDS,
  CLIP_WIDTH,
  PLAY_NS,
  type ClipFile,
} from './playback.ts';

export function writeClip(out: string): ClipFile {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  const video = `${PLAY_NS}:packaged-playback-${randomBytes(6).toString('hex')}`;
  const pkg = makeVp9Package(video, CLIP_SECONDS);
  for (const [sha, bytes] of pkg.files) {
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('a file name is not a sha256');
    writeFileSync(join(out, sha), bytes);
  }
  const clip: ClipFile = {
    v: 1,
    video: pkg.video,
    root: pkg.root,
    segs: pkg.segs,
    durationSec: pkg.durationSec,
    width: CLIP_WIDTH,
    height: CLIP_HEIGHT,
    files: [...pkg.files.keys()].sort(),
  };
  writeFileSync(join(out, CLIP_FILE), `${JSON.stringify(clip, null, 2)}\n`);
  return clip;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--out');
  const out = i === -1 ? undefined : argv[i + 1];
  if (out === undefined) throw new Error('usage: playback-clip.ts --out <dir>');
  const clip = writeClip(resolve(out));
  process.stdout.write(
    `${clip.video}: ${String(clip.files.length)} files, ${String(clip.segs)} in the hash list, ${String(clip.durationSec)} s, ${String(clip.width)}x${String(clip.height)}, root ${clip.root}\n`,
  );
}
