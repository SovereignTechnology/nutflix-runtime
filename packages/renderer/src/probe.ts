/**
 * The capability probe (ADR 0001 decision 4): whether this runtime can play through the WebRTC
 * player. `RTCPeerConnection`, WebAssembly that validates nfx's pinned verifier, Media Source
 * Extensions (hls.js feeds the `<video>` through them), and the pinned library itself, loaded and
 * started (`probePlayer`).
 *
 * When anything is missing, playback stays on the worker's progressive range server, over
 * HyperDHT alone, and `reason` says why. Pure: the environment is a parameter, so the tests pass
 * fakes, and a getter that throws counts as "missing", never as a crash.
 */
import type { LoadedPlayer, PlayerLoader } from './player/load.js';

export type Capability = 'webrtc' | 'wasm' | 'mse' | 'library';

export interface CapabilityReport {
  readonly webrtc: boolean;
  readonly wasm: boolean;
  readonly mse: boolean;
  /** Everything the WebRTC player needs is here. */
  readonly player: boolean;
  /** What is missing, in the order above. */
  readonly missing: readonly Capability[];
  /** One line for Settings, or `null` when nothing is missing. */
  readonly reason: string | null;
}

/** The part of the global scope the probe reads. */
export interface ProbeEnv {
  readonly RTCPeerConnection?: unknown;
  readonly WebAssembly?: unknown;
  readonly MediaSource?: unknown;
}

/** The smallest valid WebAssembly module: the magic and the version, no sections. */
export const EMPTY_WASM_MODULE: Uint8Array = Uint8Array.of(
  0x00,
  0x61,
  0x73,
  0x6d,
  0x01,
  0x00,
  0x00,
  0x00,
);

export interface ProbeOptions {
  /** The module to validate: `probePlayer` passes the pinned verifier. Default: the empty one. */
  readonly wasmModule?: Uint8Array | undefined;
}

const NAMES: Readonly<Record<Capability, string>> = Object.freeze({
  webrtc: 'WebRTC (RTCPeerConnection)',
  wasm: 'WebAssembly',
  mse: 'Media Source Extensions',
  library: 'The nfx player library',
});

function reasonFor(missing: readonly Capability[]): string | null {
  return missing.length === 0
    ? null
    : `${missing.map((c) => NAMES[c]).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing in this runtime: videos play over HyperDHT alone, without the WebRTC player.`;
}

function attempt(f: () => boolean): boolean {
  try {
    return f();
  } catch {
    return false;
  }
}

/** Reads a property without letting a hostile getter throw out of the probe. */
function read(o: unknown, key: string): unknown {
  try {
    return (typeof o === 'object' || typeof o === 'function') && o !== null
      ? (o as Record<string, unknown>)[key]
      : undefined;
  } catch {
    return undefined;
  }
}

export function probeCapabilities(
  env: ProbeEnv = globalThis,
  opts: ProbeOptions = {},
): CapabilityReport {
  const webrtc = attempt(() => typeof env.RTCPeerConnection === 'function');
  const wasm = attempt(() => {
    const validate = read(env.WebAssembly, 'validate');
    if (typeof validate !== 'function') return false;
    return (
      Reflect.apply(validate, env.WebAssembly, [opts.wasmModule ?? EMPTY_WASM_MODULE]) === true
    );
  });
  const mse = attempt(
    () =>
      typeof env.MediaSource === 'function' &&
      typeof read(env.MediaSource, 'isTypeSupported') === 'function',
  );
  const missing = (['webrtc', 'wasm', 'mse'] as const).filter((c) => !{ webrtc, wasm, mse }[c]);
  return {
    webrtc,
    wasm,
    mse,
    player: missing.length === 0,
    missing,
    reason: reasonFor(missing),
  };
}

export interface PlayerProbe {
  readonly report: CapabilityReport;
  /** The library, loaded and started; `null` unless `report.player`. */
  readonly player: LoadedPlayer | null;
}

/**
 * The whole probe: the three runtime checks, then the pinned library. It is loaded only when
 * they pass, its verifier must validate in this runtime, and any failure is a `library` (or
 * `wasm`) line in the report, never a rejection.
 */
export async function probePlayer(
  env: ProbeEnv = globalThis,
  load?: PlayerLoader,
): Promise<PlayerProbe> {
  const base = probeCapabilities(env);
  const unusable = (add: Capability): PlayerProbe => {
    const missing = base.missing.includes(add) ? base.missing : [...base.missing, add];
    return {
      report: {
        ...base,
        wasm: add === 'wasm' ? false : base.wasm,
        player: false,
        missing,
        reason: reasonFor(missing),
      },
      player: null,
    };
  };
  if (load === undefined) return unusable('library');
  if (!base.player) return { report: base, player: null };
  let player: LoadedPlayer;
  try {
    player = await load();
  } catch {
    return unusable('library');
  }
  if (!probeCapabilities(env, { wasmModule: player.wasm }).wasm) return unusable('wasm');
  return { report: base, player };
}
