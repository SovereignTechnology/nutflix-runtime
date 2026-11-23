/**
 * Studio in the worker: a file the user picked (main's native dialog hands the path to the worker
 * directly; a page never sees or names one) becomes an NFX video in the store, in the sizes the
 * creator chose, ready for the user's signer to sign its manifest.
 *
 *   probe → plan (core's ladder) → H.264 encode → NFX-05 CMAF package → `NfxStore`
 *
 * Every step is core's pipeline (`media.createMediaPipeline`, `media.packageNfx`) with the system's
 * ffmpeg behind `./runner.ts`. The input is untrusted: its size, length and frame size are bounded
 * here before anything is encoded. Everything written goes under `<storage>/tmp/studio-…/`, removed
 * when the job ends (the worker also wipes `tmp/` at every start). Free videos only: the draft is
 * `license open`, with no price. An error is this module's own words, never ffmpeg's stderr or a
 * path.
 */
import type { FsAdapter, MediaProbe, TranscodeOutput } from '@sovit/core';
import { media, nfx } from '@sovit/core';
import type { Logger, NfxStore, SeederFs } from '@sovit/seeder';

import { WorkerError, fail } from '../errors.js';
import type {
  StudioFfmpegWire,
  StudioProbeWire,
  StudioPublishArgs,
  StudioPublishedWire,
  StudioSourceWire,
  UnsignedEventWire,
  WorkerEvent,
} from '../protocol.js';
import {
  MAX_SOURCE_BYTES,
  MAX_SOURCE_DIMENSION,
  MAX_SOURCE_SECONDS,
  MAX_STUDIO_SOURCES,
} from '../protocol.js';
import type { WorkerRuntime, WorkerSystem } from '../runtime.js';
import { findFfmpeg } from './ffmpeg.js';
import { guardedRunner, type JobSignal } from './runner.js';

/** The network Studio publishes on, the one this build speaks (`NFX_NETWORKS`). */
export const STUDIO_NAMESPACE = 'nfx:testnet:1';
const MAX_NAME = 128;
/** A hostile file must not hold a probe open: reading a header takes moments. */
const PROBE_TIMEOUT_MS = 60_000;

export type StudioProgress = Extract<WorkerEvent, { readonly e: 'studio.progress' }>;

export interface StudioDeps {
  readonly fs: SeederFs;
  readonly rmTree: WorkerRuntime['rmTree'];
  readonly system: WorkerSystem;
  readonly store: NfxStore;
  /** `<storage>/tmp`. */
  readonly tmpDir: string;
  readonly sha256: media.Sha256Factory;
  readonly randomHex: (n: number) => string;
  readonly logger: Logger;
  readonly emit: (ev: StudioProgress) => void;
  /** Whether a signature can be had now: a publish that could not be signed is refused first. */
  readonly canSign: () => boolean;
  /**
   * The video is about to be stored: remember it as this user's, unsigned and not served. This
   * comes first, so that no crash can leave a stored video without a record of what it is.
   */
  readonly onPackaged: (video: string, root: string) => Promise<void>;
  /** It did not get stored after all. */
  readonly onAbandoned: (video: string) => Promise<void>;
  readonly now: () => number;
  /** TESTS ONLY: x264's preset (default `medium`). */
  readonly preset?: string;
}

interface Source {
  readonly path: string;
  readonly name: string;
  readonly bytes: number;
  /** One probe per file, shared by whoever asks; forgotten if it fails. */
  probe: Promise<MediaProbe> | null;
}

/** The base name for display: no directory, no control characters, capped. */
export function displayName(path: string): string {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, MAX_NAME);
  return clean === '' ? 'video' : clean;
}

const draftKey = (e: UnsignedEventWire): string =>
  JSON.stringify([e.kind, e.created_at, e.tags, e.content]);

function checkProbe(p: MediaProbe): void {
  if (p.video === undefined) fail('unsupported-input', 'this file has no video stream');
  if (!Number.isFinite(p.durationSec) || p.durationSec <= 0)
    fail('unsupported-input', 'this file does not say how long it is');
  if (p.durationSec > MAX_SOURCE_SECONDS)
    fail('unsupported-input', 'this file is longer than 4 hours');
  const { width, height } = p.video;
  if (width < 2 || height < 2 || width > MAX_SOURCE_DIMENSION || height > MAX_SOURCE_DIMENSION)
    fail('unsupported-input', 'this frame size is not supported');
}

/** A pipeline failure in this client's words: no stderr, no path. */
function mediaFailure(e: unknown): never {
  if (e instanceof WorkerError) throw e;
  if (!(e instanceof media.MediaError)) fail('internal', 'the publish failed');
  if (e.code === 'aborted') fail('session-closed', 'the publish was cancelled');
  if (e.code === 'ffmpeg-not-found') fail('ffmpeg-missing', 'ffmpeg could not be started');
  if (e.code === 'no-video-stream') fail('unsupported-input', 'this file has no video stream');
  if (e.code === 'unsupported-input')
    fail('unsupported-input', 'this file or size cannot be published');
  fail('unsupported-input', 'ffmpeg could not process this file');
}

export class Studio {
  readonly #d: StudioDeps;
  readonly #sources = new Map<string, Source>();
  #cancel: (() => void) | null = null;
  #job: Promise<unknown> | null = null;
  #closed = false;
  /** video → the canonical text of the draft waiting to be signed. */
  readonly #drafts = new Map<string, string>();

  constructor(d: StudioDeps) {
    this.#d = d;
  }

  async ffmpeg(): Promise<StudioFfmpegWire> {
    return (await findFfmpeg(this.#d.system)).status;
  }

  /** `studio.source`, from main alone: the path the user picked in the native dialog. */
  async addSource(path: string): Promise<StudioSourceWire> {
    let st;
    try {
      st = await this.#d.fs.stat(path);
    } catch {
      fail('not-found', 'that file cannot be read');
    }
    if (st?.isFile !== true) fail('not-found', 'that is not a file');
    if (st.size <= 0) fail('unsupported-input', 'that file is empty');
    if (st.size > MAX_SOURCE_BYTES) fail('unsupported-input', 'that file is larger than 16 GiB');
    while (this.#sources.size >= MAX_STUDIO_SOURCES) {
      const oldest = this.#sources.keys().next();
      if (oldest.done === true) break;
      this.#sources.delete(oldest.value);
    }
    const source = this.#d.randomHex(16);
    const name = displayName(path);
    this.#sources.set(source, { path, name, bytes: st.size, probe: null });
    return { source, name, bytes: st.size };
  }

  async probe(token: string): Promise<StudioProbeWire> {
    const source = this.#source(token);
    const found = await findFfmpeg(this.#d.system);
    if (found.paths === null) fail('ffmpeg-missing', found.status.install);
    const p = await this.#probe(source, found.paths);
    if (p.video === undefined) fail('unsupported-input', 'this file has no video stream');
    const sizes = media.sourceSizes(p);
    const shown = media.displayDimensions(p.video);
    return {
      durationSec: p.durationSec,
      width: shown.width,
      height: shown.height,
      sizes: sizes.sizes.map((s) => ({ height: s.height, original: s.original, kbps: s.kbps })),
    };
  }

  /**
   * Whether `event` is exactly the manifest draft this worker made for `video`. A signature is
   * only ever given to that draft, so a compromised page cannot have the user sign another title
   * or another revision of their video.
   */
  isDraft(video: string, event: UnsignedEventWire): boolean {
    return this.#drafts.get(video) === draftKey(event);
  }

  /** The draft was signed: it is not signed twice. */
  forgetDraft(video: string): void {
    this.#drafts.delete(video);
  }

  /** Stop the running encode. */
  cancel(): boolean {
    if (this.#cancel === null) return false;
    this.#cancel();
    return true;
  }

  async publish(a: StudioPublishArgs): Promise<StudioPublishedWire> {
    if (this.#closed) fail('backend-down', 'worker is shutting down');
    if (this.#job !== null) fail('rate-limited', 'another video is being published');
    const source = this.#source(a.source);
    if (!this.#d.canSign()) fail('no-signer', 'unlock or connect a signer before publishing');
    // One pick, one publish: a page cannot loop encodes on a file the user chose once.
    this.#sources.delete(a.source);
    const job = this.#run(source, a);
    this.#job = job;
    try {
      return await job;
    } finally {
      this.#job = null;
      this.#cancel = null;
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.cancel();
    await this.#job?.catch(() => undefined);
  }

  #source(token: string): Source {
    const s = this.#sources.get(token);
    if (s === undefined) fail('not-found', 'pick the file again');
    return s;
  }

  #probe(source: Source, binaries: media.FfmpegPaths): Promise<MediaProbe> {
    source.probe ??= this.#runProbe(source, binaries).catch((e: unknown) => {
      source.probe = null;
      throw e;
    });
    return source.probe;
  }

  async #runProbe(source: Source, binaries: media.FfmpegPaths): Promise<MediaProbe> {
    const pipeline = media.createMediaPipeline({
      runner: guardedRunner({
        runner: this.#d.system.runner,
        binaries,
        source: source.path,
        workDir: this.#d.tmpDir,
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
      fs: this.#fsAdapter(),
      sha256: this.#d.sha256,
      binaries,
    });
    let p: MediaProbe;
    try {
      p = await pipeline.probe(source.path);
    } catch (e) {
      mediaFailure(e);
    }
    checkProbe(p);
    return p;
  }

  #fsAdapter(): FsAdapter {
    const { fs, rmTree, randomHex } = this.#d;
    return {
      readFile: (p) => fs.readFile(p),
      writeFile: (p, data) => fs.writeFile(p, data),
      stat: async (p) => {
        const st = await fs.stat(p);
        if (st === null) throw new Error('no such file');
        return { size: st.size };
      },
      mkdtemp: async (prefix) => {
        const dir = `${prefix}${randomHex(6)}`;
        await fs.mkdir(dir, { recursive: true });
        return dir;
      },
      rm: (p) => rmTree(p),
      readChunks: (p) => fs.readStream(p),
    };
  }

  async #run(source: Source, a: StudioPublishArgs): Promise<StudioPublishedWire> {
    const d = this.#d;
    const found = await findFfmpeg(d.system);
    if (found.paths === null) fail('ffmpeg-missing', found.status.install);
    const binaries = found.paths;
    const workDir = d.fs.join(d.tmpDir, `studio-${d.randomHex(8)}`);
    const listeners: (() => void)[] = [];
    const cancel: JobSignal & { aborted: boolean } = {
      aborted: false,
      addEventListener(_t, cb) {
        listeners.push(cb);
      },
    };
    this.#cancel = () => {
      if (cancel.aborted) return;
      cancel.aborted = true;
      for (const cb of listeners.splice(0)) cb();
    };
    // A function, so that no check below is narrowed by the one before it.
    const stopIfCancelled = (): void => {
      if (cancel.aborted) fail('session-closed', 'the publish was cancelled');
    };
    const fsa = this.#fsAdapter();
    const runner = guardedRunner({
      runner: d.system.runner,
      binaries,
      source: source.path,
      workDir,
      cancel,
    });
    const emit = (p: Omit<StudioProgress, 'op' | 'e'>): void => {
      d.emit({ op: 'ev', e: 'studio.progress', ...p });
    };
    try {
      await d.fs.mkdir(workDir, { recursive: true });
      emit({ stage: 'probing' });
      const probe = await this.#probe(source, binaries);
      stopIfCancelled();
      const pipeline = media.createMediaPipeline({
        runner,
        fs: fsa,
        sha256: d.sha256,
        binaries,
        ...(d.preset === undefined ? {} : { preset: d.preset }),
      });
      let output: TranscodeOutput;
      let packaged: media.NfxPackaged;
      const ns = nfx.Namespace.parse(STUDIO_NAMESPACE);
      if (!ns.ok) fail('internal', 'the namespace does not parse');
      const addr = nfx.VideoAddr.parse(`${STUDIO_NAMESPACE}:nutflix-${d.randomHex(16)}`);
      if (!addr.ok) fail('internal', 'the video address does not parse');
      try {
        const plan = pipeline.plan(probe, { sizes: a.sizes });
        let last = '';
        output = await pipeline.transcode(
          source.path,
          plan,
          (p) => {
            if (p.stage === 'rendition') {
              const percent = Math.max(0, Math.min(100, Math.floor(p.percent)));
              const key = `${p.label}:${String(percent)}`;
              if (key === last) return;
              last = key;
              emit({ stage: 'encoding', rendition: p.label, percent });
            } else if (p.stage === 'thumbnails') {
              if (last !== 'thumbnails') emit({ stage: 'thumbnails' });
              last = 'thumbnails';
            }
          },
          { workDir },
        );
        stopIfCancelled();
        emit({ stage: 'packaging' });
        const thumb = output.thumbnails[0];
        packaged = await media.packageNfx(
          {
            runner,
            fs: fsa,
            sha256: d.sha256,
            binaries,
            workDirPrefix: `${workDir}/nfx-`,
          },
          {
            video: addr.value,
            renditions: output.renditions.map((r) => ({
              spec: r.spec,
              path: r.path,
              width: r.width,
              height: r.height,
            })),
            ...(thumb === undefined ? {} : { thumbnailPath: thumb.path }),
          },
        );
      } catch (e) {
        mediaFailure(e);
      }
      stopIfCancelled();
      emit({ stage: 'storing' });
      const bySha = new Map(packaged.files.map((f) => [f.entry.sha256, f] as const));
      await d.onPackaged(addr.value.toString(), packaged.root);
      let put: Awaited<ReturnType<NfxStore['putVideo']>>;
      try {
        put = await d.store.putVideo({
          video: addr.value,
          root: packaged.root,
          segs: packaged.segs,
          hashListBytes: packaged.hashListBytes,
          read: async (entry) => {
            const f = bySha.get(entry.sha256);
            if (f === undefined) throw new Error('not in the package');
            return f.source.kind === 'bytes' ? f.source.bytes : fsa.readFile(f.source.path);
          },
        });
      } catch (e) {
        await d.onAbandoned(addr.value.toString()).catch(() => undefined);
        throw e;
      }
      if (!put.ok) {
        await d.onAbandoned(addr.value.toString()).catch(() => undefined);
        if (put.error === 'disk-cap') fail('disk-cap', 'storing this video would pass the cap');
        fail('io', 'the video could not be stored');
      }
      const video = put.record.video;
      let bytes = 0;
      for (const f of put.record.files) bytes += f.size;
      const now = d.now();
      const thumbFile = packaged.hashList.files.find((f) => f.role === 'thumb');
      const manifest: nfx.Manifest = {
        author: '',
        createdAt: now,
        addr: addr.value,
        title: a.title,
        publishedAt: BigInt(now),
        root: packaged.root,
        segs: packaged.segs,
        duration: BigInt(Math.max(1, Math.round(probe.durationSec))),
        thumb:
          thumbFile === undefined ? undefined : { sha256: thumbFile.sha256, mime: 'image/jpeg' },
        priceHint: undefined,
        license: { mode: 'open' },
        hashtags: [...a.tags],
        alt: undefined,
        description: a.description,
      };
      d.logger.info('studio: video packaged', { video, files: put.record.files.length });
      const draft: UnsignedEventWire = {
        kind: nfx.KIND_MANIFEST,
        created_at: now,
        tags: nfx.manifestTags(manifest),
        content: a.description,
      };
      while (this.#drafts.size >= MAX_STUDIO_SOURCES) {
        const oldest = this.#drafts.keys().next();
        if (oldest.done === true) break;
        this.#drafts.delete(oldest.value);
      }
      this.#drafts.set(video, draftKey(draft));
      return {
        video,
        root: packaged.root,
        segs: Number(packaged.segs),
        files: put.record.files.length,
        bytes,
        draft,
      };
    } finally {
      await d.rmTree(workDir).catch(() => undefined);
    }
  }
}
