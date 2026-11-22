// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { EMPTY_WASM_MODULE, probeCapabilities, type ProbeEnv } from '../probe.js';

const ctor = (): void => undefined;

const FULL: ProbeEnv = {
  RTCPeerConnection: ctor,
  WebAssembly: { validate: (b: Uint8Array) => b.length >= 8 },
  MediaSource: Object.assign(() => undefined, { isTypeSupported: () => true }),
};

describe('probeCapabilities', () => {
  it('finds everything the WebRTC player needs, and has no reason to give', () => {
    expect(probeCapabilities(FULL)).toEqual({
      webrtc: true,
      wasm: true,
      mse: true,
      player: true,
      missing: [],
      reason: null,
    });
  });

  it('reports each missing piece by name, in order, with a reason', () => {
    const { RTCPeerConnection: _a, ...noRtc } = FULL;
    expect(probeCapabilities(noRtc)).toMatchObject({
      webrtc: false,
      wasm: true,
      mse: true,
      player: false,
      missing: ['webrtc'],
      reason:
        'WebRTC (RTCPeerConnection) is missing in this runtime: videos play over HyperDHT alone, without the WebRTC player.',
    });
    const { MediaSource: _b, WebAssembly: _c, ...onlyRtc } = FULL;
    const r = probeCapabilities(onlyRtc);
    expect(r.missing).toEqual(['wasm', 'mse']);
    expect(r.reason).toBe(
      'WebAssembly, Media Source Extensions are missing in this runtime: videos play over HyperDHT alone, without the WebRTC player.',
    );
    expect(probeCapabilities({}).missing).toEqual(['webrtc', 'wasm', 'mse']);
  });

  it('asks WebAssembly.validate about the module it is given, the empty module by default', () => {
    const seen: Uint8Array[] = [];
    const env: ProbeEnv = {
      ...FULL,
      WebAssembly: {
        validate(b: Uint8Array) {
          seen.push(b);
          return true;
        },
      },
    };
    probeCapabilities(env);
    expect(seen[0]).toBe(EMPTY_WASM_MODULE);
    expect([...EMPTY_WASM_MODULE]).toEqual([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);
    const mine = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9);
    probeCapabilities(env, { wasmModule: mine });
    expect(seen[1]).toBe(mine);
  });

  it('a module the runtime rejects, or a validate that is not a function, is missing WASM', () => {
    expect(probeCapabilities({ ...FULL, WebAssembly: { validate: () => false } }).missing).toEqual([
      'wasm',
    ]);
    expect(probeCapabilities({ ...FULL, WebAssembly: { validate: () => 'yes' } }).missing).toEqual([
      'wasm',
    ]);
    expect(probeCapabilities({ ...FULL, WebAssembly: { validate: 1 } }).missing).toEqual(['wasm']);
    expect(probeCapabilities({ ...FULL, WebAssembly: null }).missing).toEqual(['wasm']);
  });

  it('MediaSource must be a constructor that can say what it supports', () => {
    expect(probeCapabilities({ ...FULL, MediaSource: ctor }).missing).toEqual(['mse']);
    expect(
      probeCapabilities({ ...FULL, MediaSource: { isTypeSupported: () => true } }).missing,
    ).toEqual(['mse']);
  });

  it('never throws: a hostile getter or a validate that throws counts as missing', () => {
    const env = {
      get RTCPeerConnection(): unknown {
        throw new Error('no');
      },
      WebAssembly: {
        validate(): boolean {
          throw new Error('no');
        },
      },
      get MediaSource(): unknown {
        throw new Error('no');
      },
    } as ProbeEnv;
    expect(probeCapabilities(env).missing).toEqual(['webrtc', 'wasm', 'mse']);
  });

  it('reads the real global scope by default', () => {
    const r = probeCapabilities();
    expect(typeof r.player).toBe('boolean');
    expect(r.wasm).toBe(true);
  });
});
