/**
 * Finding the SYSTEM ffmpeg, adapted from nutflix-pear's `app-desktop/src/worker/ffmpeg.ts` (the
 * submodule's pinned commit; ADR 0005 there: ffmpeg is not bundled). The first `ffmpeg` on `PATH`,
 * then in the usual package-manager directories (an app launched from a desktop often has a short
 * `PATH`), with an `ffprobe` beside it. Absolute directories only, so never the current directory.
 * "Works" means executable, and `ffmpeg -version` exits 0 within a few seconds.
 */
import type { media } from '@sovit/core';

import type { StudioFfmpegWire } from '../protocol.js';
import type { WorkerSystem } from '../runtime.js';

type Os = WorkerSystem['os'];

const EXTRA_DIRS: Readonly<Record<Os, readonly string[]>> = {
  linux: ['/usr/bin', '/usr/local/bin'],
  macos: ['/opt/homebrew/bin', '/usr/local/bin'],
  windows: [],
};

/** Shown when ffmpeg is missing: one line, plain text. */
export const INSTALL_HINT: Readonly<Record<Os, string>> = {
  linux: 'Install ffmpeg with your package manager, for example: sudo apt install ffmpeg',
  macos: 'Install ffmpeg with Homebrew: brew install ffmpeg',
  windows: 'Install ffmpeg, for example: winget install Gyan.FFmpeg, then restart Nutflix',
};

const exe = (os: Os, name: 'ffmpeg' | 'ffprobe'): string =>
  os === 'windows' ? `${name}.exe` : name;

export function ffmpegCandidates(pathEnv: string | undefined, os: Os): string[] {
  const sep = os === 'windows' ? '\\' : '/';
  const dirs = [...(pathEnv ?? '').split(os === 'windows' ? ';' : ':'), ...EXTRA_DIRS[os]];
  const out = new Set<string>();
  for (const d of dirs) {
    const dir = d.replace(/[\\/]+$/, '');
    const absolute = os === 'windows' ? /^[A-Za-z]:[\\/]/.test(d) : d.startsWith('/');
    if (absolute && dir !== '') out.add(`${dir}${sep}${exe(os, 'ffmpeg')}`);
  }
  return [...out];
}

export function siblingFfprobe(ffmpeg: string, os: Os): string {
  const i = Math.max(ffmpeg.lastIndexOf('/'), ffmpeg.lastIndexOf('\\'));
  return `${ffmpeg.slice(0, i + 1)}${exe(os, 'ffprobe')}`;
}

/** `ffmpeg version 6.1.1-3ubuntu5 Copyright …` → `6.1.1-3ubuntu5`, printable ASCII, capped. */
export function parseFfmpegVersion(firstLine: string): string | undefined {
  const m = /^ffmpeg version (\S+)/.exec(firstLine.trim());
  const v = m?.[1]?.replace(/[^\x21-\x7e]/g, '');
  return v === undefined || v === '' ? undefined : v.slice(0, 64);
}

export interface FoundFfmpeg {
  readonly status: StudioFfmpegWire;
  readonly paths: media.FfmpegPaths | null;
}

/** Never throws. */
export async function findFfmpeg(
  system: Pick<WorkerSystem, 'os' | 'pathEnv' | 'runner' | 'isExecutable'>,
  timeoutMs = 5000,
): Promise<FoundFfmpeg> {
  const install = INSTALL_HINT[system.os];
  for (const ffmpeg of ffmpegCandidates(system.pathEnv, system.os)) {
    const ffprobe = siblingFfprobe(ffmpeg, system.os);
    if (!(await system.isExecutable(ffmpeg)) || !(await system.isExecutable(ffprobe))) continue;
    const listeners: (() => void)[] = [];
    const signal = {
      aborted: false,
      addEventListener(_t: 'abort', cb: () => void): void {
        listeners.push(cb);
      },
    };
    const timer = setTimeout(() => {
      signal.aborted = true;
      for (const cb of listeners) cb();
    }, timeoutMs);
    try {
      const r = await system.runner.run(ffmpeg, ['-hide_banner', '-version'], { signal });
      if (r.exitCode !== 0) continue;
      let text = '';
      for (const b of r.stdout.subarray(0, 512)) text += b < 0x80 ? String.fromCharCode(b) : '?';
      const version = parseFfmpegVersion(text.split(/\r?\n/, 1)[0] ?? '');
      return {
        status: { found: true, install, ...(version === undefined ? {} : { version }) },
        paths: { ffmpeg, ffprobe },
      };
    } catch {
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  return { status: { found: false, install }, paths: null };
}
