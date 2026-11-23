/**
 * Studio's handling of an untrusted file, with a fake ffmpeg: what it is told to run (no network,
 * no playlists, only this job's files), and what it refuses before anything is encoded. The real
 * encode is proved in the seed-and-publish job (`packages/renderer/e2e/publish/`).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { MediaProbe, ProcessRunner, RenditionSpec } from '@sovit/core';
import { media, signer as coreSigner } from '@sovit/core';
import { nodeFs } from '@sovit/seeder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import { MAX_SOURCE_BYTES, MAX_SOURCE_SECONDS } from '../protocol.js';
import { ffmpegCandidates, findFfmpeg, siblingFfprobe } from '../studio/ffmpeg.js';
import {
  INPUT_PROTOCOLS,
  MAX_OUTPUT_BYTES,
  MAX_SOURCE_PIXELS,
  SOURCE_FORMATS,
  guardArgv,
  guardedRunner,
} from '../studio/runner.js';
import { displayName } from '../studio/studio.js';
import { nodeRuntime, nodeSystem, startWorker, tempDir } from './helpers/harness.js';

vi.setConfig({ testTimeout: 30_000 });

const SOURCE = '/home/u/clip.mp4';
const WORK = '/data/worker/tmp/studio-1';

const probe: MediaProbe = {
  container: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 10,
  video: { codec: 'h264', width: 1280, height: 720, fps: 30 },
};
const spec: RenditionSpec = media.sizeSpec(720);

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** Everything before the first `-i`: the input's options. */
function inputOptions(argv: readonly string[]): readonly string[] {
  return argv.slice(0, argv.indexOf('-i'));
}

describe('what ffmpeg is told', () => {
  it('reads the picked file with no network protocol and no playlist demuxer', () => {
    const argv = guardArgv(
      'ffmpeg',
      media.renditionArgv(SOURCE, `${WORK}/720p.mp4`, probe, spec, { fps: 30 }),
      SOURCE,
      WORK,
    );
    const opts = inputOptions(argv);
    expect(opts[opts.indexOf('-protocol_whitelist') + 1]).toBe(INPUT_PROTOCOLS);
    expect(INPUT_PROTOCOLS).toBe('file,pipe');
    expect(opts[opts.indexOf('-format_whitelist') + 1]).toBe(SOURCE_FORMATS);
    expect(opts[opts.indexOf('-max_pixels') + 1]).toBe(String(MAX_SOURCE_PIXELS));
    for (const banned of ['hls', 'dash', 'concat', 'http', 'tcp', 'rtmp', 'data', 'lavfi'])
      expect(SOURCE_FORMATS.split(','), banned).not.toContain(banned);
    expect(argv[argv.length - 1]).toBe(`${WORK}/720p.mp4`);
    expect(argv[argv.indexOf('-fs') + 1]).toBe(String(MAX_OUTPUT_BYTES));
    // A header that lies about the length cannot make an output longer than the cap.
    expect(argv[argv.indexOf('-t') + 1]).toBe(String(MAX_SOURCE_SECONDS));
  });

  it('guards the thumbnail, placeholder and storyboard reads of the picked file', () => {
    for (const a of [
      media.thumbnailArgv(SOURCE, `${WORK}/t.jpg`, 1),
      media.placeholderArgv(SOURCE, `${WORK}/p.jpg`, 1),
      media.storyboardArgv(SOURCE, `${WORK}/s.jpg`, {
        intervalSec: 2,
        cols: 2,
        rows: 2,
        tileWidth: 160,
      }),
    ]) {
      const opts = inputOptions(guardArgv('ffmpeg', a, SOURCE, WORK));
      expect(opts).toContain('-protocol_whitelist');
      expect(opts).toContain('-format_whitelist');
      expect(opts).toContain('-max_pixels');
    }
  });

  it('keeps the remux’s own narrower guard and adds no size limit to the HLS muxer', () => {
    const argv = guardArgv(
      'ffmpeg',
      media.cmafRemuxArgv(`${WORK}/720p.mp4`, `${WORK}/nfx-720p-1`),
      SOURCE,
      WORK,
    );
    const opts = inputOptions(argv);
    expect(opts.filter((x) => x === '-protocol_whitelist')).toHaveLength(1);
    expect(opts[opts.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(argv).not.toContain('-fs');
  });

  it('guards ffprobe of the picked file, and of this job’s own outputs', () => {
    const src = guardArgv('ffprobe', media.ffprobeArgv(SOURCE), SOURCE, WORK);
    expect(src).toContain('-format_whitelist');
    expect(src).toContain('-max_pixels');
    expect(src.filter((x) => x === '-protocol_whitelist')).toHaveLength(1);
    expect(src[src.length - 1]).toBe(SOURCE);
    // A JPEG this job wrote is no container: it is read without the container list.
    const own = guardArgv('ffprobe', media.ffprobeArgv(`${WORK}/s.jpg`), SOURCE, WORK);
    expect(own).not.toContain('-format_whitelist');
  });

  it.each([
    ['another file', ['-i', '/etc/passwd', '-f', 'mp4', `${WORK}/o.mp4`]],
    ['a URL', ['-i', 'http://evil.example/x', '-f', 'mp4', `${WORK}/o.mp4`]],
    ['a protocol', ['-i', 'concat:/etc/passwd|/etc/group', '-f', 'mp4', `${WORK}/o.mp4`]],
    ['an escape from the job', ['-i', `${WORK}/../../x`, '-f', 'mp4', `${WORK}/o.mp4`]],
    ['no input', ['-f', 'mp4', `${WORK}/o.mp4`]],
    ['two inputs', ['-i', SOURCE, '-i', SOURCE, '-f', 'mp4', `${WORK}/o.mp4`]],
    ['an output elsewhere', ['-i', SOURCE, '-f', 'mp4', '/home/u/.bashrc']],
    ['an output escaping the job', ['-i', SOURCE, '-f', 'mp4', `${WORK}/../o.mp4`]],
    ['a network output', ['-i', SOURCE, '-f', 'mp4', 'rtmp://evil.example/x']],
  ])('refuses %s', (_name, args) => {
    expect(() => guardArgv('ffmpeg', args, SOURCE, WORK)).toThrow(/^internal: /);
  });

  it('runs only ffmpeg and ffprobe, and a cancel reaches the process', async () => {
    let aborted = false;
    const runner: ProcessRunner = {
      run: (_f, _a, opts) =>
        new Promise((_resolve, reject) => {
          opts?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new media.ProcessRunnerError('aborted', 'ffmpeg'));
          });
        }),
    };
    const listeners: (() => void)[] = [];
    const cancel = {
      aborted: false,
      addEventListener: (_t: 'abort', cb: () => void) => void listeners.push(cb),
    };
    const g = guardedRunner({
      runner,
      binaries: { ffmpeg: '/usr/bin/ffmpeg', ffprobe: '/usr/bin/ffprobe' },
      source: SOURCE,
      workDir: WORK,
      cancel,
    });
    await expect(g.run('/bin/sh', ['-c', 'id'])).rejects.toThrow(/not ffmpeg/);
    const running = g.run('/usr/bin/ffmpeg', ['-i', SOURCE, '-f', 'mp4', `${WORK}/o.mp4`]);
    for (const l of listeners) l();
    await expect(running).rejects.toThrow();
    expect(aborted).toBe(true);
  });
});

describe('finding ffmpeg', () => {
  it('looks only in absolute directories, never the current one', () => {
    const c = ffmpegCandidates('.:relative/bin:/opt/x/bin:', 'linux');
    expect(c).toContain('/opt/x/bin/ffmpeg');
    expect(c.every((p) => p.startsWith('/'))).toBe(true);
    expect(siblingFfprobe('/opt/x/bin/ffmpeg', 'linux')).toBe('/opt/x/bin/ffprobe');
    expect(ffmpegCandidates('C:\\tools;relative', 'windows')).toEqual(['C:\\tools\\ffmpeg.exe']);
  });

  it.each([
    ['linux', /apt install ffmpeg/],
    ['macos', /brew install ffmpeg/],
    ['windows', /winget install/],
  ] as const)('says how to install it on %s', async (os, hint) => {
    const r = await findFfmpeg({
      os,
      pathEnv: '',
      runner: { run: () => Promise.reject(new Error('no process runs')) },
      isExecutable: () => Promise.resolve(false),
    });
    expect(r.paths).toBeNull();
    expect(r.status.found).toBe(false);
    expect(r.status.install).toMatch(hint);
  });
});

describe('the display name', () => {
  it('is the base name, with no directory and no control characters', () => {
    expect(displayName('/home/u/My Clip.mp4')).toBe('My Clip.mp4');
    expect(displayName('C:\\Users\\me\\clip.mkv')).toBe('clip.mkv');
    expect(displayName('/x/a\u0007b.mp4')).toBe('ab.mp4');
    expect(displayName('/x/')).toBe('video');
    expect(displayName(`/x/${'n'.repeat(500)}`)).toHaveLength(128);
  });
});

/** A worker whose ffmpeg and ffprobe are this fake. */
async function fakeStudio(
  ffprobeJson: unknown,
  extra: { readonly stat?: typeof nodeFs.stat } = {},
): Promise<{
  w: ReturnType<typeof startWorker>;
  file: string;
  dir: string;
  calls: string[][];
}> {
  const d = await tempDir('nf-studio-');
  cleanups.push(() => d.rm());
  const file = join(d.dir, 'clip.mp4');
  await writeFile(file, new Uint8Array(32).fill(1));
  const calls: string[][] = [];
  const system = nodeSystem({
    os: 'linux',
    pathEnv: '/fake/bin',
    isExecutable: (p) => Promise.resolve(p.startsWith('/fake/bin/')),
    runner: {
      run: (f, args) => {
        calls.push([f, ...args]);
        const stdout = args.includes('-version')
          ? new TextEncoder().encode('ffmpeg version 7.1 Copyright\n')
          : new TextEncoder().encode(JSON.stringify(ffprobeJson));
        return Promise.resolve({ exitCode: 0, stdout, stderr: '' });
      },
    },
  });
  const base = nodeRuntime(system);
  const w = startWorker({
    runtime: extra.stat === undefined ? base : { ...base, fs: { ...nodeFs, stat: extra.stat } },
    signerCost: coreSigner.minimumCost(),
  });
  cleanups.push(() => w.close());
  await w.client.request('init', {
    v: 1,
    storage: join(d.dir, 'storage', 'worker'),
    bootstrap: [{ host: '127.0.0.1', port: 9 }],
  });
  return { w, file, dir: d.dir, calls };
}

const ffprobeOf = (o: {
  duration?: string;
  width?: number;
  height?: number;
  video?: boolean;
}): unknown => ({
  format: { format_name: 'matroska,webm', duration: o.duration ?? '10.0' },
  streams:
    o.video === false
      ? [{ codec_type: 'audio', codec_name: 'aac', channels: 2, sample_rate: '48000' }]
      : [
          {
            codec_type: 'video',
            codec_name: 'h264',
            width: o.width ?? 1280,
            height: o.height ?? 720,
            avg_frame_rate: '30/1',
          },
        ],
});

const code = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkerError ? e.code : 'not-a-worker-error';
  }
};

describe('an untrusted file, refused before anything is encoded', () => {
  it('reports the sizes of a good file, never a path', async () => {
    const { w, file, dir } = await fakeStudio(ffprobeOf({}));
    const s = await w.client.request('studio.source', { path: file });
    expect(s.name).toBe('clip.mp4');
    expect(s.source).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(s)).not.toContain(dir);
    const p = await w.client.request('studio.probe', { source: s.source });
    expect(p).toMatchObject({ durationSec: 10, width: 1280, height: 720 });
    expect(p.sizes.map((x) => x.height)).toEqual([720, 480, 360]);
    expect(JSON.stringify(p)).not.toContain(dir);
  });

  it.each([
    ['longer than 4 hours', { duration: String(4 * 3600 + 1) }],
    ['no length', { duration: '0' }],
    ['a frame too wide', { width: 7682 }],
    ['a frame too tall', { height: 7682 }],
    ['no video stream', { video: false }],
  ])('%s', async (_name, f) => {
    const { w, file } = await fakeStudio(ffprobeOf(f));
    const s = await w.client.request('studio.source', { path: file });
    expect(await code(w.client.request('studio.probe', { source: s.source }))).toBe(
      'unsupported-input',
    );
  });

  it('a directory, a missing file, an empty file and one past the size cap', async () => {
    const { w, file, dir } = await fakeStudio(ffprobeOf({}));
    const sub = join(dir, 'a-directory');
    await mkdir(sub);
    expect(await code(w.client.request('studio.source', { path: sub }))).toBe('not-found');
    expect(await code(w.client.request('studio.source', { path: `${file}.gone` }))).toBe(
      'not-found',
    );
    const empty = join(dir, 'empty.mp4');
    await writeFile(empty, new Uint8Array(0));
    expect(await code(w.client.request('studio.source', { path: empty }))).toBe(
      'unsupported-input',
    );
    const big = await fakeStudio(ffprobeOf({}), {
      stat: () => Promise.resolve({ size: MAX_SOURCE_BYTES + 1, isFile: true, isDirectory: false }),
    });
    expect(await code(big.w.client.request('studio.source', { path: big.file }))).toBe(
      'unsupported-input',
    );
  });

  it('a token it did not hand out', async () => {
    const { w } = await fakeStudio(ffprobeOf({}));
    const source = 'ab'.repeat(16);
    expect(await code(w.client.request('studio.probe', { source }))).toBe('not-found');
    expect(
      await code(
        w.client.request('studio.publish', {
          source,
          title: 't',
          description: '',
          tags: [],
          sizes: [720],
        }),
      ),
    ).toBe('not-found');
  });

  it('refuses to encode with no signer ready', async () => {
    const { w, file, calls } = await fakeStudio(ffprobeOf({}));
    const s = await w.client.request('studio.source', { path: file });
    expect(
      await code(
        w.client.request('studio.publish', {
          source: s.source,
          title: 't',
          description: '',
          tags: [],
          sizes: [720],
        }),
      ),
    ).toBe('no-signer');
    expect(calls).toEqual([]);
  });

  it('one pick is good for one publish', async () => {
    const { w, file } = await fakeStudio(ffprobeOf({}));
    await w.client.request('signer.local.create', { passphrase: 'a passphrase for this test' });
    const s = await w.client.request('studio.source', { path: file });
    const publish = (): Promise<unknown> =>
      w.client.request('studio.publish', {
        source: s.source,
        title: 't',
        description: '',
        tags: [],
        sizes: [720],
      });
    // The fake ffmpeg writes nothing, so this one fails after it started.
    expect(await code(publish())).not.toBe('ok');
    expect(await code(publish())).toBe('not-found');
  });

  it('every call to the fake ffprobe carried the guard', async () => {
    const { w, file, calls } = await fakeStudio(ffprobeOf({}));
    const s = await w.client.request('studio.source', { path: file });
    await w.client.request('studio.probe', { source: s.source });
    const probes = calls.filter((c) => c[0] === '/fake/bin/ffprobe');
    expect(probes.length).toBeGreaterThan(0);
    for (const c of probes) {
      expect(c).toContain('-protocol_whitelist');
      expect(c).toContain('-format_whitelist');
    }
  });

  it('with no ffmpeg, the probe says how to install it', async () => {
    const d = await tempDir('nf-studio-');
    cleanups.push(() => d.rm());
    const file = join(d.dir, 'clip.mp4');
    await writeFile(file, new Uint8Array(8).fill(1));
    const w = startWorker({
      runtime: nodeRuntime(
        nodeSystem({ os: 'linux', pathEnv: '', isExecutable: () => Promise.resolve(false) }),
      ),
    });
    cleanups.push(() => w.close());
    await w.client.request('init', {
      v: 1,
      storage: join(d.dir, 'storage', 'worker'),
      bootstrap: [{ host: '127.0.0.1', port: 9 }],
    });
    expect(await w.client.request('studio.ffmpeg', {})).toMatchObject({ found: false });
    const s = await w.client.request('studio.source', { path: file });
    await expect(w.client.request('studio.probe', { source: s.source })).rejects.toMatchObject({
      code: 'ffmpeg-missing',
      message: expect.stringContaining('sudo apt install ffmpeg') as string,
    });
  });
});
