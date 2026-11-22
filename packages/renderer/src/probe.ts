/**
 * The capability probe (ADR 0001 decision 4): which of the three things the WebRTC player needs
 * this runtime has. `RTCPeerConnection`, WebAssembly that can validate a module (nfx's verifier
 * is WASM) and Media Source Extensions (hls.js feeds the `<video>` through them).
 *
 * In this slice the probe only reports. Slice B adds the WebRTC player, and plays through it when
 * `player` is true; when anything is missing, playback stays on the worker's progressive range
 * server, over HyperDHT alone, and `reason` says why. Pure: the environment is a parameter, so
 * the tests pass fakes, and a getter that throws counts as "missing", never as a crash.
 */

export type Capability = 'webrtc' | 'wasm' | 'mse';

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
  /** The module to validate: slice B passes the pinned verifier's bytes. Default: the empty one. */
  readonly wasmModule?: Uint8Array | undefined;
}

const NAMES: Readonly<Record<Capability, string>> = Object.freeze({
  webrtc: 'WebRTC (RTCPeerConnection)',
  wasm: 'WebAssembly',
  mse: 'Media Source Extensions',
});

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
    reason:
      missing.length === 0
        ? null
        : `${missing.map((c) => NAMES[c]).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing in this runtime: videos play over HyperDHT alone, without the WebRTC player.`,
  };
}
