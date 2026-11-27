/**
 * The WebRTC player's pieces, without a browser: the pin (lock and tar), the loader, the whole
 * probe, the settings that decide a play's path and what Settings says, and the session with a
 * fake library: that `remoteCandidates` is always `global`, the session key is the library's, and
 * a player that fails hands the same `<video>` to the worker's progressive stream.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NfxAddress, NfxSettings } from '@sovit/core';

import {
  LIB_FILES,
  checkLibrary,
  parseLock,
  readPinnedLibrary,
  readUstar,
  wasmModuleSource,
} from '../../scripts/nfx-lib.ts';
import { WebRtcNfxSession, problemOf } from '../adapter/webrtc-session.js';
import { isWorkerOriginUrl } from '../links.js';
import { createPlayerLoader, decodeBase64, type LoadedPlayer } from '../player/load.js';
import type {
  NfxLibSession,
  NfxOpenOptions,
  NfxPlayerEvent,
  NfxPlayerLib,
} from '../player/nfx-lib.js';
import { probePlayer, type ProbeEnv } from '../probe.js';
import { DEFAULT_NFX } from '../settings/defaults.js';
import { isSettingsPatch, isStunServer } from '../settings/validate.js';
import { beaconOriginsText, webrtcOff, webrtcPlan, webrtcStatusText } from '../settings/webrtc.js';
import { ORIGINS_NOTE_ID, WEBRTC_NOTE_ID, installWebRtcNote } from '../settings/webrtc-note.js';
import { FakeWorker } from './support/fake-worker.js';

const pkg = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('the pin', () => {
  it('the committed tar is the one the lock names, with the four files of nfx’s lib-tar.sh', () => {
    const lib = readPinnedLibrary(pkg);
    expect(lib.lock.commit).toMatch(/^[0-9a-f]{40}$/);
    const tar = readFileSync(
      join(pkg, 'pinned', `nfx-web-lib-${lib.lock.commit.slice(0, 12)}.tar`),
    );
    expect(hex(tar)).toBe(lib.lock.libSha256);
    expect([...readUstar(tar).keys()]).toEqual([...LIB_FILES]);
    expect(lib.wasmSha256).toBe(hex(lib.wasm));
    expect([...lib.wasm.subarray(0, 4)]).toEqual([0, 0x61, 0x73, 0x6d]);
  });

  it('refuses a tar with one byte changed', () => {
    const lib = readPinnedLibrary(pkg);
    const tar = new Uint8Array(
      readFileSync(join(pkg, 'pinned', `nfx-web-lib-${lib.lock.commit.slice(0, 12)}.tar`)),
    );
    tar[1000] = (tar[1000] ?? 0) ^ 1;
    expect(() => checkLibrary(lib.lock, tar)).toThrow(/sha256/);
  });

  it('reads the lock strictly', () => {
    const line = `nfx ${'a'.repeat(40)} ${'b'.repeat(64)} ${'c'.repeat(64)}`;
    expect(parseLock(`# note\n${line}\ntool rust 1\n`)).toEqual({
      commit: 'a'.repeat(40),
      srcSha256: 'b'.repeat(64),
      libSha256: 'c'.repeat(64),
    });
    expect(() => parseLock('# nothing\n')).toThrow(/exactly one/);
    expect(() => parseLock(`${line}\n${line}\n`)).toThrow(/exactly one/);
    expect(() => parseLock(`nfx ${'A'.repeat(40)} ${'b'.repeat(64)} ${'c'.repeat(64)}\n`)).toThrow(
      /malformed/,
    );
  });

  /** One ustar member, with a right checksum. */
  function member(name: string, body: Uint8Array, type = '0'): Uint8Array {
    const h = new Uint8Array(512);
    const put = (at: number, s: string): void => {
      h.set(Buffer.from(s, 'latin1'), at);
    };
    put(0, name);
    put(124, `${body.length.toString(8).padStart(11, '0')}\0`);
    put(156, type);
    put(257, 'ustar\x0000');
    put(148, '        ');
    const sum = h.reduce((n, b) => n + b, 0);
    put(148, `${sum.toString(8).padStart(6, '0')}\0 `);
    const pad = new Uint8Array((512 - (body.length % 512)) % 512);
    return Buffer.concat([h, body, pad]);
  }
  const end = new Uint8Array(1024);

  it('takes regular files only, and no name that leaves the directory', () => {
    const body = Uint8Array.of(1, 2, 3);
    expect([
      ...(readUstar(Buffer.concat([member('a/b.js', body), end])).get('a/b.js') ?? []),
    ]).toEqual([1, 2, 3]);
    expect(() => readUstar(Buffer.concat([member('link', body, '2'), end]))).toThrow(/regular/);
    expect(() => readUstar(Buffer.concat([member('../evil', body), end]))).toThrow(/unsafe/);
    expect(() => readUstar(Buffer.concat([member('/abs', body), end]))).toThrow(/unsafe/);
    expect(() => readUstar(Buffer.concat([member('a', body), member('a', body), end]))).toThrow(
      /duplicate/,
    );
    const bad = member('a', body);
    bad[0] = 0x62;
    expect(() => readUstar(Buffer.concat([bad, end]))).toThrow(/checksum/);
    expect(() => readUstar(member('a', body).subarray(0, 512))).toThrow(/truncated/);
  });

  it('writes the WASM as a module whose default export decodes to the same bytes', () => {
    const bytes = Uint8Array.of(0, 0x61, 0x73, 0x6d, 255, 254);
    const m = /^export default "([A-Za-z0-9+/=]+)";\n$/.exec(wasmModuleSource(bytes));
    expect(decodeBase64(m?.[1] ?? '')).toEqual(bytes);
    expect(() => decodeBase64('abc')).toThrow();
    expect(() => decodeBase64('ab!d')).toThrow();
  });
});

describe('the loader', () => {
  const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);
  const b64 = Buffer.from(WASM).toString('base64');

  function setup(over: { text?: unknown; player?: unknown; sha?: string } = {}): {
    readonly load: () => Promise<LoadedPlayer>;
    readonly imported: string[];
    readonly inits: unknown[];
    readonly revoked: string[];
  } {
    const imported: string[] = [];
    const inits: unknown[] = [];
    const revoked: string[] = [];
    const player = over.player ?? {
      init: (o: unknown) => {
        inits.push(o);
        return Promise.resolve();
      },
      open: () => Promise.reject(new Error('unused')),
    };
    const load = createPlayerLoader({
      baseUrl: 'app://nutflix/index.html',
      wasmSha256: over.sha ?? hex(WASM),
      importModule: (url) => {
        imported.push(url);
        return Promise.resolve(url.endsWith('wasm.js') ? { default: over.text ?? b64 } : player);
      },
      sha256: (b) => Promise.resolve(hex(b)),
      createObjectURL: () => 'blob:app://nutflix/1',
      revokeObjectURL: (u) => revoked.push(u),
    });
    return { load, imported, inits, revoked };
  }

  it('checks the WASM against the pin, starts the library on a blob: URL and revokes it', async () => {
    const s = setup();
    const loaded = await s.load();
    expect(s.imported).toEqual(['app://nutflix/nfx/wasm.js', 'app://nutflix/nfx/player.js']);
    expect(loaded.wasm).toEqual(WASM);
    expect(s.inits).toEqual([{ wasmUrl: 'blob:app://nutflix/1' }]);
    expect(s.revoked).toEqual(['blob:app://nutflix/1']);
    // Once.
    expect(await s.load()).toBe(loaded);
    expect(s.imported).toHaveLength(2);
  });

  it('refuses a verifier that is not the pinned one, before it loads the library', async () => {
    const s = setup({ sha: 'f'.repeat(64) });
    await expect(s.load()).rejects.toThrow(/not the pinned/);
    expect(s.imported).toEqual(['app://nutflix/nfx/wasm.js']);
    expect(s.inits).toEqual([]);
  });

  it('refuses a build with no pin, a module with no bytes, a library with no API', async () => {
    await expect(setup({ sha: '' }).load()).rejects.toThrow(/no WASM pin/);
    await expect(setup({ text: 7 }).load()).rejects.toThrow(/no bytes/);
    await expect(setup({ player: { init: 1 } }).load()).rejects.toThrow(/no init or open/);
  });

  it('a failed load may be tried again', async () => {
    let n = 0;
    const load = createPlayerLoader({
      baseUrl: 'app://nutflix/',
      wasmSha256: hex(WASM),
      importModule: (url) => {
        if (url.endsWith('wasm.js')) {
          n += 1;
          return n === 1 ? Promise.reject(new Error('no')) : Promise.resolve({ default: b64 });
        }
        return Promise.resolve({ init: () => Promise.resolve(), open: () => undefined });
      },
      sha256: (b) => Promise.resolve(hex(b)),
      createObjectURL: () => 'blob:x',
      revokeObjectURL: () => undefined,
    });
    await expect(load()).rejects.toThrow('no');
    await expect(load()).resolves.toBeDefined();
  });
});

describe('the whole probe', () => {
  const ctor = (): void => undefined;
  const WASM = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 9);
  const env = (validate: (b: Uint8Array) => boolean = () => true): ProbeEnv => ({
    RTCPeerConnection: ctor,
    WebAssembly: { validate },
    MediaSource: Object.assign(() => undefined, { isTypeSupported: () => true }),
  });
  const lib: NfxPlayerLib = {
    init: () => Promise.resolve(),
    open: () => Promise.reject(new Error('unused')),
  };

  it('passes with the three capabilities and a library whose pinned WASM validates', async () => {
    const seen: Uint8Array[] = [];
    const r = await probePlayer(
      env((b) => {
        seen.push(b);
        return true;
      }),
      () => Promise.resolve({ lib, wasm: WASM }),
    );
    expect(r.report.player).toBe(true);
    expect(r.report.reason).toBeNull();
    expect(r.player?.lib).toBe(lib);
    expect(seen).toContain(WASM);
  });

  it('a library that does not load, or no loader, is a reason and no player', async () => {
    const failed = await probePlayer(env(), () => Promise.reject(new Error('no')));
    expect(failed.player).toBeNull();
    expect(failed.report.player).toBe(false);
    expect(failed.report.missing).toEqual(['library']);
    expect(failed.report.reason).toMatch(/^The nfx player library is missing/);
    expect((await probePlayer(env())).report.missing).toEqual(['library']);
  });

  it('a load that never ends is a reason and no player, not a hang', async () => {
    const r = await probePlayer(env(), () => new Promise(() => undefined), 5);
    expect(r.player).toBeNull();
    expect(r.report.missing).toEqual(['library']);
  });

  it('a pinned WASM this runtime will not validate is a reason and no player', async () => {
    const r = await probePlayer(
      env((b) => b !== WASM),
      () => Promise.resolve({ lib, wasm: WASM }),
    );
    expect(r.player).toBeNull();
    expect(r.report.missing).toEqual(['wasm']);
  });

  it('never loads the library when a capability is missing', async () => {
    const load = vi.fn(() => Promise.resolve({ lib, wasm: WASM }));
    const { RTCPeerConnection: _gone, ...noRtc } = env();
    const r = await probePlayer(noRtc, load);
    expect(load).not.toHaveBeenCalled();
    expect(r.player).toBeNull();
    expect(r.report.missing).toEqual(['webrtc']);
  });
});

describe('the WebRTC settings', () => {
  const nfx = (o: Partial<NfxSettings>): NfxSettings => ({ ...DEFAULT_NFX, ...o });

  it('is on by default, on the defaults’ relays and STUN server', () => {
    expect(webrtcOff(DEFAULT_NFX)).toBeNull();
    expect(webrtcOff(undefined)).toBeNull();
    expect(webrtcPlan(DEFAULT_NFX)).toEqual({
      meshRelays: ['wss://relay.primal.net', 'wss://relay.ditto.pub'],
      iceServers: [{ urls: ['stun:web.nutflix.xyz:3478'] }],
    });
  });

  it('is off when switched off, or with no relay or no STUN server', () => {
    expect(webrtcOff(nfx({ webrtc: false }))).toBe('switched-off');
    expect(webrtcOff(nfx({ meshRelays: [] }))).toBe('no-relays');
    expect(webrtcOff(nfx({ stunServers: [] }))).toBe('no-stun');
    expect(webrtcPlan(nfx({ webrtc: false }))).toBeNull();
  });

  it('says why in Settings, the runtime’s reason first', () => {
    expect(webrtcStatusText(null, DEFAULT_NFX)).toBeNull();
    expect(webrtcStatusText(null, nfx({ webrtc: false }))).toMatch(/you switched it off/);
    expect(webrtcStatusText(null, nfx({ meshRelays: [] }))).toMatch(/no signaling relay/);
    expect(webrtcStatusText(null, nfx({ stunServers: [] }))).toMatch(/no STUN server/);
    expect(webrtcStatusText('WebAssembly is missing.', nfx({ webrtc: false }))).toBe(
      'WebRTC is off. WebAssembly is missing.',
    );
    // Off means no peer: a video its seeders serve over HTTPS still plays, from those hosts.
    expect(webrtcStatusText(null, nfx({ webrtc: false }))).toMatch(
      /no peer connections\. Videos play over HyperDHT, or from the HTTPS hosts/,
    );
    // A window that fetches no HTTPS (shape b) says HyperDHT alone.
    expect(webrtcStatusText(null, nfx({ webrtc: false }), false)).toMatch(
      /you switched it off: videos play over HyperDHT alone\.$/,
    );
  });

  it('says which hosts a play may reach besides peers, only where the web player may fetch them', () => {
    expect(beaconOriginsText(true)).toMatch(/HTTPS.*see your IP address/s);
    expect(beaconOriginsText(false)).toBeNull();
    expect(beaconOriginsText(true, false)).toBeNull();
  });

  it('takes the three fields in a patch, and refuses what is not one', () => {
    const with_ = (o: unknown): unknown => ({ nfx: { ...DEFAULT_NFX, ...(o as object) } });
    expect(isSettingsPatch(with_({ webrtc: false }))).toBe(true);
    expect(isSettingsPatch(with_({ meshRelays: ['ws://127.0.0.1:7777'] }))).toBe(true);
    expect(isSettingsPatch(with_({ stunServers: ['203.0.113.7:3478'] }))).toBe(true);
    expect(isSettingsPatch(with_({ webrtc: 'no' }))).toBe(false);
    expect(isSettingsPatch(with_({ meshRelays: ['http://relay.example'] }))).toBe(false);
    expect(isSettingsPatch(with_({ meshRelays: ['ws://relay.example'] }))).toBe(false);
    expect(isSettingsPatch(with_({ meshRelays: ['wss://a.example', 'wss://a.example'] }))).toBe(
      false,
    );
    expect(
      isSettingsPatch(
        with_({
          meshRelays: Array.from({ length: 9 }, (_, i) => `wss://r${String(i)}.example`),
        }),
      ),
    ).toBe(false);
    expect(
      isSettingsPatch(
        with_({ stunServers: Array.from({ length: 5 }, (_, i) => `s${String(i)}.example:3478`) }),
      ),
    ).toBe(false);
  });

  it('reads a STUN server as host:port, no scheme', () => {
    for (const ok of ['web.nutflix.xyz:3478', '203.0.113.7:1', '[2001:db8::1]:65535'])
      expect(isStunServer(ok), ok).toBe(true);
    for (const bad of [
      'stun:a.example:3478',
      'a.example',
      'a.example:0',
      'a.example:65536',
      '-a.example:1',
      'a b:1',
      'a.example:1/x',
      7,
    ])
      expect(isStunServer(bad), String(bad)).toBe(false);
  });

  it('keeps the note right after the switch’s row, as text, while there is a reason', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const row = document.createElement('div');
    row.className = 'nf-settings__row';
    const sw = document.createElement('input');
    sw.setAttribute('role', 'switch');
    sw.id = 'x-nfx-webrtc';
    row.append(sw);
    let line: string | null = '<img src=x onerror=alert(1)> is the reason';
    const note = installWebRtcNote(root, () => line);
    expect(document.getElementById(WEBRTC_NOTE_ID)).toBeNull();
    root.append(row);
    await flush();
    const p = document.getElementById(WEBRTC_NOTE_ID);
    expect(row.nextElementSibling).toBe(p);
    expect(p?.textContent).toBe(line);
    expect(p?.querySelector('img')).toBeNull();
    line = null;
    note.refresh();
    expect(document.getElementById(WEBRTC_NOTE_ID)).toBeNull();
    line = 'again';
    note.refresh();
    expect(document.getElementById(WEBRTC_NOTE_ID)?.textContent).toBe('again');
    note.stop();
    expect(document.getElementById(WEBRTC_NOTE_ID)).toBeNull();
    root.remove();
  });

  it('keeps the HTTPS-hosts line after the status line, or right after the row without one', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const row = document.createElement('div');
    row.className = 'nf-settings__row';
    const sw = document.createElement('input');
    sw.setAttribute('role', 'switch');
    sw.id = 'x-nfx-webrtc';
    row.append(sw);
    // `@sovit/ui`'s own notice, after the row.
    const theirs = document.createElement('p');
    root.append(row, theirs);
    let status: string | null = 'off';
    let hosts: string | null = '<b>hosts</b> see your IP address';
    const note = installWebRtcNote(
      root,
      () => status,
      () => hosts,
    );
    await flush();
    const s = document.getElementById(WEBRTC_NOTE_ID);
    const h = document.getElementById(ORIGINS_NOTE_ID);
    expect([row.nextElementSibling, s?.nextElementSibling, h?.nextElementSibling]).toEqual([
      s,
      h,
      theirs,
    ]);
    expect(h?.textContent).toBe(hosts);
    expect(h?.querySelector('b')).toBeNull();
    status = null;
    note.refresh();
    await flush();
    expect(document.getElementById(WEBRTC_NOTE_ID)).toBeNull();
    expect(row.nextElementSibling).toBe(h);
    hosts = null;
    note.refresh();
    expect(document.getElementById(ORIGINS_NOTE_ID)).toBeNull();
    expect(row.nextElementSibling).toBe(theirs);
    note.stop();
    root.remove();
  });
});

describe('isWorkerOriginUrl', () => {
  it('is the worker’s loopback base, and nothing else', () => {
    const t = 'a'.repeat(32);
    expect(isWorkerOriginUrl(`http://127.0.0.1:4000/${t}`)).toBe(true);
    for (const bad of [
      `https://127.0.0.1:4000/${t}`,
      `http://localhost:4000/${t}`,
      `http://127.0.0.1/${t}`,
      `http://127.0.0.1:0/${t}`,
      `http://127.0.0.1:4000/${t}/`,
      `http://127.0.0.1:4000/${t}?a=1`,
      `http://127.0.0.1:4000/${'A'.repeat(32)}`,
      `http://evil.example:4000/${t}`,
      null,
    ])
      expect(isWorkerOriginUrl(bad), String(bad)).toBe(false);
  });
});

describe('the WebRTC session', () => {
  const ORIGIN = `http://127.0.0.1:4100/${'b'.repeat(32)}`;
  const STREAM = `http://127.0.0.1:4101/${'c'.repeat(32)}/${'d'.repeat(32)}`;
  const addr = `38504:${'e'.repeat(64)}:nfx:testnet:1:free-video` as NfxAddress;

  class FakeLib implements NfxPlayerLib {
    readonly opened: { el: HTMLVideoElement; options: NfxOpenOptions }[] = [];
    readonly sessions: (NfxLibSession & { destroyed: number })[] = [];
    readonly setLevels: number[] = [];
    fails = false;
    init = (): Promise<void> => Promise.resolve();
    open(el: HTMLVideoElement, options: NfxOpenOptions): Promise<NfxLibSession> {
      this.opened.push({ el, options });
      if (this.fails) return Promise.reject(new Error(`secret ${ORIGIN}`));
      const s = {
        destroyed: 0,
        levels: [],
        setLevel: (i: number): void => {
          this.setLevels.push(i);
        },
        destroy() {
          this.destroyed += 1;
        },
      };
      this.sessions.push(s);
      return Promise.resolve(s);
    }
    emit(e: NfxPlayerEvent): void {
      this.opened.at(-1)?.options.onEvent?.(e);
    }
  }

  function make(o: { pin?: string; progressiveFails?: boolean } = {}): {
    readonly session: WebRtcNfxSession;
    readonly lib: FakeLib;
    readonly worker: FakeWorker;
    readonly el: HTMLVideoElement;
    readonly play: ReturnType<typeof vi.fn>;
    readonly progressive: { calls: number };
  } {
    const lib = new FakeLib();
    const worker = new FakeWorker();
    const el = document.createElement('video');
    const play = vi.fn(() => Promise.resolve());
    el.play = play;
    const progressive = { calls: 0 };
    const session = new WebRtcNfxSession({
      videoId: addr,
      manifestJson: '{"kind":38504}',
      sid: '1'.repeat(32),
      originUrl: ORIGIN,
      renditions: [{ id: '720p', bandwidth: 2 }],
      pin: o.pin,
      meshRelays: ['wss://relay.example'],
      iceServers: [{ urls: ['stun:stun.example:3478'] }],
      player: lib,
      worker,
      openProgressive: () => {
        progressive.calls += 1;
        return o.progressiveFails === true
          ? Promise.reject(new Error('no'))
          : Promise.resolve({
              sid: '2'.repeat(32),
              url: STREAM,
              rendition: '720p',
              renditions: [
                { id: '720p', bandwidth: 2 },
                { id: '360p', bandwidth: 1 },
              ],
            });
      },
    });
    return { session, lib, worker, el, play, progressive };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('opens the player on the worker’s origin, with the global candidate filter, always', async () => {
    const { session, lib, el } = make();
    session.source.attach(el);
    await flush();
    const o = lib.opened[0]?.options;
    expect(lib.opened[0]?.el).toBe(el);
    expect(o?.origins).toEqual([ORIGIN]);
    expect(o?.manifestJson).toBe('{"kind":38504}');
    expect(o?.signaling).toEqual({
      kind: 'nostr',
      relays: ['wss://relay.example'],
      remoteCandidates: 'global',
    });
    expect(o?.iceServers).toEqual([{ urls: ['stun:stun.example:3478'] }]);
    // Keys are the library's own per-session: this renderer hands it none.
    expect(JSON.stringify(Object.keys(o ?? {}))).not.toMatch(/key|secret|nsec/i);
    expect(o?.renditions).toBeUndefined();
    expect(session.fellBack).toBe(false);
  });

  it('a viewer’s rendition is asked for and pinned once the levels arrive', async () => {
    const { session, lib, el } = make({ pin: '360p' });
    session.source.attach(el);
    await flush();
    expect(lib.opened[0]?.options.renditions).toEqual(['360p']);
    lib.emit({
      type: 'levels',
      levels: [
        { index: 0, id: '720p', width: 1280, height: 720, bitrate: 2 },
        { index: 1, id: '360p', width: 640, height: 360, bitrate: 1 },
      ],
    });
    expect(lib.setLevels).toEqual([1]);
    expect(session.rendition).toBe('360p');
    expect(session.renditions.map((r) => r.id)).toEqual(['720p', '360p']);
  });

  it('falls back when the player will not start: same element, the worker’s stream', async () => {
    const { session, lib, worker, el, play, progressive } = make();
    lib.fails = true;
    const changed = vi.fn();
    session.onChange(changed);
    session.source.attach(el);
    await flush();
    expect(progressive.calls).toBe(1);
    expect(worker.closes).toEqual(['1'.repeat(32)]);
    expect(el.getAttribute('src')).toBe(STREAM);
    expect(play).toHaveBeenCalled();
    expect(session.fellBack).toBe(true);
    expect(session.sid).toBe('2'.repeat(32));
    expect(session.rendition).toBe('720p');
    expect(session.renditions.map((r) => r.id)).toEqual(['720p']);
    expect(changed).toHaveBeenCalled();
    // In this client's words: no library message, so no origin token.
    expect(JSON.stringify(session.problems)).not.toContain('b'.repeat(32));
    expect(session.problems.at(-1)?.message).toMatch(/playing over HyperDHT alone/);
    await session.close();
    expect(worker.closes).toEqual(['1'.repeat(32), '2'.repeat(32)]);
  });

  it('falls back on a fatal error at runtime, once, and destroys the player', async () => {
    const { session, lib, el, progressive } = make();
    session.source.attach(el);
    await flush();
    lib.emit({ type: 'error', message: 'mediaError:bufferAppendError' });
    lib.emit({ type: 'error', message: 'again' });
    await flush();
    expect(lib.sessions[0]?.destroyed).toBe(1);
    expect(progressive.calls).toBe(1);
    expect(el.getAttribute('src')).toBe(STREAM);
    await expect(session.setRendition('720p')).rejects.toThrow(/no such rendition/);
  });

  it('a refused autoplay is not a failure', async () => {
    const { session, lib, el, progressive } = make();
    session.source.attach(el);
    await flush();
    lib.emit({ type: 'error', message: 'play: NotAllowedError' });
    await flush();
    expect(progressive.calls).toBe(0);
    expect(session.fellBack).toBe(false);
  });

  it('says so when the stream will not open either', async () => {
    const { session, lib, el } = make({ progressiveFails: true });
    lib.fails = true;
    session.source.attach(el);
    await flush();
    expect(session.problems.at(-1)?.message).toMatch(/did not open either/);
    expect(el.getAttribute('src')).toBeNull();
  });

  it('a close during the fallback closes what the fallback opened', async () => {
    const { session, lib, worker, el } = make();
    lib.fails = true;
    session.source.attach(el);
    await Promise.resolve();
    await session.close();
    await flush();
    expect(worker.closes).toContain('1'.repeat(32));
    expect(el.getAttribute('src')).toBeNull();
  });

  it('detaching destroys the player; closing is idempotent and closes the worker once', async () => {
    const { session, lib, worker, el } = make();
    const off = session.source.attach(el);
    await flush();
    off();
    expect(lib.sessions[0]?.destroyed).toBe(1);
    await session.close();
    await session.close();
    expect(worker.closes).toEqual(['1'.repeat(32)]);
  });

  it('shows problems in its own words, never a remote string', () => {
    const remote = 'http://evil.example/<b>';
    for (const e of [
      { type: 'rejected', sha256: null, url: remote, why: remote },
      { type: 'origin', origin: remote, ok: false, why: remote },
      { type: 'log', message: `mesh: rejected p2p bytes for ${remote}: ${remote}` },
    ] as const) {
      const p = problemOf(e);
      expect(p).not.toBeNull();
      expect(p?.message).not.toContain('evil');
    }
    expect(problemOf({ type: 'origin', origin: remote, ok: true })).toBeNull();
    expect(problemOf({ type: 'log', message: 'hello' })).toBeNull();
    expect(problemOf({ type: 'playing' })).toBeNull();
  });
});
