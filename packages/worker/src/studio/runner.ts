/**
 * The only way Studio runs ffmpeg and ffprobe: a `ProcessRunner` around the system's that treats
 * the input file as hostile. Core's argv builders never use a shell; on top of them, every call is
 * rewritten and checked here:
 *
 *   - **no network:** every input gets `-protocol_whitelist file,pipe` (the remux has its own,
 *     narrower one), so a playlist inside a file cannot make ffmpeg open a URL;
 *   - **no playlists:** the picked file may be read only by real container demuxers
 *     (`-format_whitelist`). HLS, DASH and concat are the ones that would read OTHER local files
 *     named inside the input, and put their bytes in a video the user then publishes;
 *   - **no giant frames:** `-max_pixels` holds every decoder of the picked file to the frame cap,
 *     whichever stream it opens and whatever a later header in the stream claims;
 *   - **only these files:** every input must be the picked file or inside this job's directory,
 *     and every output must be inside it;
 *   - **bounded:** each output stops at `MAX_SOURCE_SECONDS` of media and `MAX_OUTPUT_BYTES`, each
 *     process at `PROCESS_TIMEOUT_MS`, and a cancel kills the running process.
 */
import type { ProcessRunner, media } from '@sovit/core';

import { fail } from '../errors.js';
import { MAX_SOURCE_DIMENSION, MAX_SOURCE_SECONDS } from '../protocol.js';

/** The real containers Studio accepts as input (ffmpeg's demuxer names). */
export const SOURCE_FORMATS = 'mov,matroska,webm,avi,mpegts';
export const INPUT_PROTOCOLS = 'file,pipe';
/** The largest frame any decoder of the picked file may allocate. */
export const MAX_SOURCE_PIXELS = MAX_SOURCE_DIMENSION * MAX_SOURCE_DIMENSION;
/** The most one encoded output may be. */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024 * 1024;
/** The longest one ffmpeg or ffprobe process may run. */
export const PROCESS_TIMEOUT_MS = 8 * 3600 * 1000;

const slashes = (p: string): string => p.replaceAll('\\', '/');
const unfile = (p: string): string => (p.startsWith('file:') ? p.slice('file:'.length) : p);

function insideDir(path: string, dir: string): boolean {
  const p = slashes(path);
  const d = slashes(dir).replace(/\/+$/, '');
  return p.startsWith(`${d}/`) && !p.split('/').includes('..');
}

function checkInput(input: string | undefined, source: string, workDir: string): string {
  if (input === undefined) fail('internal', 'an ffmpeg call without an input');
  const p = unfile(input);
  if (p !== source && !insideDir(p, workDir)) fail('internal', 'ffmpeg was aimed at another file');
  return p;
}

/** `args`, with the guards in. Throws on an input or output outside this job. */
export function guardArgv(
  kind: 'ffmpeg' | 'ffprobe',
  args: readonly string[],
  source: string,
  workDir: string,
  maxOutputBytes: number = MAX_OUTPUT_BYTES,
): string[] {
  if (kind === 'ffprobe') {
    const input = checkInput(args[args.length - 1], source, workDir);
    const out = args.slice(0, -1);
    if (!out.includes('-protocol_whitelist')) out.push('-protocol_whitelist', INPUT_PROTOCOLS);
    if (input === source)
      out.push('-format_whitelist', SOURCE_FORMATS, '-max_pixels', String(MAX_SOURCE_PIXELS));
    out.push(args[args.length - 1] ?? '');
    return out;
  }
  const out: string[] = [];
  let inputs = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? '';
    if (a === '-i') {
      inputs += 1;
      const input = checkInput(args[i + 1], source, workDir);
      const guarded = args[i - 4] === '-protocol_whitelist' && args[i - 2] === '-format_whitelist';
      if (!guarded) {
        out.push('-protocol_whitelist', INPUT_PROTOCOLS);
        if (input === source)
          out.push('-format_whitelist', SOURCE_FORMATS, '-max_pixels', String(MAX_SOURCE_PIXELS));
      }
    }
    out.push(a);
  }
  if (inputs !== 1) fail('internal', 'an ffmpeg call must have one input');
  const output = args[args.length - 1] ?? '';
  if (!insideDir(output, workDir)) fail('internal', 'ffmpeg was told to write elsewhere');
  const fIndex = args.lastIndexOf('-f');
  // A file can lie about its length in its header: the output is cut at the cap either way.
  if (args[fIndex + 1] !== 'hls')
    out.splice(out.length - 1, 0, '-t', String(MAX_SOURCE_SECONDS), '-fs', String(maxOutputBytes));
  return out;
}

export interface JobSignal {
  readonly aborted: boolean;
  addEventListener(type: 'abort', cb: () => void): void;
}

export interface GuardedRunnerOptions {
  readonly runner: ProcessRunner;
  readonly binaries: media.FfmpegPaths;
  /** The file the user picked. */
  readonly source: string;
  /** This job's directory, inside the worker's storage. */
  readonly workDir: string;
  readonly cancel?: JobSignal;
  /**
   * What the next output may still take of this job's budget, asked before each ffmpeg run. At
   * zero or less the run is refused.
   */
  readonly outputRoom?: () => Promise<number>;
  /** TESTS ONLY. */
  readonly timeoutMs?: number;
}

export function guardedRunner(o: GuardedRunnerOptions): ProcessRunner {
  return {
    run: async (file, args, opts) => {
      const kind =
        file === o.binaries.ffmpeg ? 'ffmpeg' : file === o.binaries.ffprobe ? 'ffprobe' : null;
      if (kind === null) throw new Error('internal: not ffmpeg');
      let room = MAX_OUTPUT_BYTES;
      if (kind === 'ffmpeg' && o.outputRoom !== undefined) {
        room = Math.min(room, Math.floor(await o.outputRoom()));
        if (room <= 0) throw new Error('internal: this job has used its disk budget');
      }
      const argv = guardArgv(kind, args, o.source, o.workDir, room);
      const listeners: (() => void)[] = [];
      const signal = {
        aborted: o.cancel?.aborted === true,
        addEventListener(_t: 'abort', cb: () => void): void {
          listeners.push(cb);
        },
      };
      const abort = (): void => {
        if (signal.aborted) return;
        signal.aborted = true;
        for (const cb of listeners) cb();
      };
      o.cancel?.addEventListener('abort', abort);
      const timer = setTimeout(abort, o.timeoutMs ?? PROCESS_TIMEOUT_MS);
      try {
        return await o.runner.run(file, argv, {
          ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
          ...(opts?.onStderrLine === undefined ? {} : { onStderrLine: opts.onStderrLine }),
          signal,
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
