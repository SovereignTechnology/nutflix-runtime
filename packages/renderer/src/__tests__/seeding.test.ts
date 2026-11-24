/**
 * Seeding and publishing in the renderer, against a scripted worker and relay pool: beacons go to
 * the scoped relays only and only if they verify; nothing is asked of the worker while nothing is
 * served; a published manifest must verify before it reaches a relay; only bytes the player
 * verified are handed over; and Settings says plainly that seeding shares the IP address.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { NfxVideo, NostrEvent, RelayUrl, Settings } from '@sovit/core';
import { beaconTags, parseBeacon } from '@sovit/core/nfx';
import { FakeRelayPool } from '@sovit/core/nostr';
import { hyperdhtEndpoint } from '@sovit/seeder';
import type {
  SeedingStatusWire,
  SignerStatusWire,
  StudioPublishedWire,
  WorkerEvent,
} from '@nutflix-runtime/worker';
import DHT from 'hyperdht';

import { startRenderer, type RendererClient } from '../main.js';
import {
  BEACON_EVERY_MS,
  PUBLISH_DECLINED,
  SERVING_EVENT,
  SIGNER_EVENT,
  SeedPublish,
  type SeedPublishOptions,
} from '../seeding/controller.js';
import {
  ACCOUNT_MENU_NOTE,
  PANEL_ID,
  SEEDING_DISCLOSURE,
  installSeedPublishPanel,
} from '../seeding/panel.js';
import { MAX_TAP_PENDING, SegmentTap, TAP_CHUNK_BYTES, toBase64 } from '../seeding/segment-tap.js';
import { DEFAULT_SETTINGS } from '../settings/defaults.js';
import { SettingsStore } from '../settings/store.js';
import type { ControlMethod, ControlWorker, WorkerPipe } from '../worker/pipe.js';
import { Key, NS, addrOf, manifest } from './support/nfx.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Math.floor(Date.now() / 1000);
const SCOPED = 'ws://127.0.0.1:7001' as RelayUrl;
const WRITE = 'wss://write.example' as RelayUrl;
const READ_ONLY = 'wss://read.example' as RelayUrl;
const SHA = 'ef'.repeat(32);
const SID = 'ab'.repeat(16);

const settings: Settings = {
  ...DEFAULT_SETTINGS,
  relays: [
    { url: WRITE, read: true, write: true },
    { url: READ_ONLY, read: true, write: false },
  ],
  nfx: { enabled: true, network: 'nfx:testnet:1', scopedRelays: [SCOPED] },
};

const IDLE: SeedingStatusWire = { watched: false, videos: [], listening: [] };
const servedStatus = (over: Partial<SeedingStatusWire> = {}): SeedingStatusWire => ({
  watched: false,
  videos: [
    {
      video: `${NS}:nutflix-${'a'.repeat(32)}`,
      files: 4,
      bytes: 100,
      origin: 'published',
      served: true,
      stopped: false,
    },
  ],
  listening: [{ namespace: NS, connections: 0 }],
  ...over,
});

const SIGNER: SignerStatusWire = {
  kind: 'none',
  pubkey: null,
  locked: true,
  keyFile: false,
  localAllowed: true,
};

interface Call {
  readonly m: string;
  readonly a: unknown;
}

class FakeControl implements ControlWorker {
  readonly calls: Call[] = [];
  readonly listeners = new Set<(ev: WorkerEvent) => void>();
  answers: Partial<Record<ControlMethod, (a: never) => unknown>> = {};

  call(m: ControlMethod, a: unknown): Promise<never> {
    this.calls.push({ m, a });
    const f = this.answers[m] as ((x: unknown) => unknown) | undefined;
    if (f === undefined) return Promise.reject(new Error(`internal: no answer for ${m}`));
    try {
      return Promise.resolve(f(a) as never);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error('failed'));
    }
  }

  onEvent(cb: (ev: WorkerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  emit(ev: unknown): void {
    for (const l of [...this.listeners]) l(ev as WorkerEvent);
  }

  count(m: string): number {
    return this.calls.filter((c) => c.m === m).length;
  }
}

function beaconEvent(video = `${NS}:nutflix-${'a'.repeat(32)}`): NostrEvent {
  const seeder = new Key();
  const kp = DHT.keyPair();
  const endpoint = hyperdhtEndpoint(kp, seeder.pubkey, NS);
  const address = `38504:${'cd'.repeat(32)}:${video}`;
  const tags = beaconTags(address, NOW, 120);
  if (!tags.ok) throw new Error(tags.error.reason);
  return seeder.sign({
    kind: 20464,
    created_at: NOW,
    tags: tags.value,
    content: JSON.stringify({
      v: 1,
      video,
      endpoints: [endpoint],
      chunks: 'all',
      price_hint: 0,
      free: true,
    }),
  });
}

function world(over: Partial<SeedPublishOptions> = {}): {
  worker: FakeControl;
  published: { relays: readonly string[]; event: NostrEvent }[];
  c: SeedPublish;
  tick: () => void;
  intervals: () => number;
} {
  const worker = new FakeControl();
  worker.answers['seeding.status'] = () => IDLE;
  const published: { relays: readonly string[]; event: NostrEvent }[] = [];
  let tick: () => void = () => undefined;
  let intervals = 0;
  const c = new SeedPublish({
    worker,
    pool: {
      publish: (relays, event) => {
        published.push({ relays, event });
        return Promise.resolve(relays.map((url) => ({ url, ok: true })));
      },
    },
    settings: { get: () => settings },
    now: () => NOW,
    timers: {
      setInterval: (fn, ms) => {
        expect(ms).toBe(BEACON_EVERY_MS);
        intervals += 1;
        tick = fn;
        return intervals;
      },
      clearInterval: () => {
        tick = () => undefined;
      },
    },
    ...over,
  });
  return {
    worker,
    published,
    c,
    tick: () => {
      tick();
    },
    intervals: () => intervals,
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('beacons', () => {
  it('with nothing served: no timer, no request for a beacon', async () => {
    const w = world();
    await w.c.refreshSeeding();
    await settle();
    expect(w.intervals()).toBe(0);
    expect(w.worker.count('seeding.beacons')).toBe(0);
  });

  it('asks the worker nothing until it is told something is served', async () => {
    const w = world();
    const off = w.c.listen();
    w.worker.emit({ op: 'ev', e: 'status', status: { listening: [] } });
    await settle();
    expect(w.worker.calls).toEqual([]);
    w.worker.answers['seeding.status'] = () => servedStatus();
    w.worker.answers['seeding.beacons'] = () => ({ events: [] });
    w.worker.emit({ op: 'ev', e: SERVING_EVENT, networks: 1 });
    await settle();
    expect(w.worker.count('seeding.status')).toBe(1);
    expect(w.worker.count('seeding.beacons')).toBe(1);
    off();
  });

  it('publishes what verifies to the scoped relays, and to nothing else', async () => {
    const w = world();
    const good = beaconEvent();
    const forged = { ...beaconEvent(), content: '{"tampered":true}' };
    w.worker.answers['seeding.status'] = () => servedStatus();
    w.worker.answers['seeding.beacons'] = () => ({ events: [good, forged] });
    await w.c.refreshSeeding();
    await settle();
    expect(w.intervals()).toBe(1);
    expect(w.published.map((p) => p.event.id)).toEqual([good.id]);
    expect(w.published[0]?.relays).toEqual([SCOPED]);
    expect(parseBeacon(w.published[0]?.event, NOW).ok).toBe(true);
    w.tick();
    await settle();
    expect(w.worker.count('seeding.beacons')).toBe(2);
  });

  it('with no scoped relay, it publishes none (never to the general relays)', async () => {
    const worker = new FakeControl();
    worker.answers['seeding.status'] = () => servedStatus();
    const publish = vi.fn(() => Promise.resolve([]));
    const c = new SeedPublish({
      worker,
      pool: { publish },
      settings: {
        get: () => ({
          ...settings,
          nfx: { enabled: true, network: 'nfx:testnet:1', scopedRelays: [] },
        }),
      },
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    });
    await c.refreshSeeding();
    await settle();
    expect(worker.count('seeding.beacons')).toBe(0);
    expect(publish).not.toHaveBeenCalled();
  });

  it('stops when nothing is served any more', async () => {
    const w = world();
    w.worker.answers['seeding.status'] = () => servedStatus();
    w.worker.answers['seeding.beacons'] = () => ({ events: [] });
    await w.c.refreshSeeding();
    await settle();
    w.worker.answers['seeding.status'] = () => IDLE;
    await w.c.refreshSeeding();
    await settle();
    const before = w.worker.count('seeding.beacons');
    w.tick();
    await settle();
    expect(w.worker.count('seeding.beacons')).toBe(before);
  });
});

describe('seed what you watch', () => {
  const video = (): NfxVideo => {
    const creator = new Key();
    const event = manifest(creator, 'free-video-1', { createdAt: NOW - 60 });
    return { event, id: addrOf(creator, 'free-video-1') } as unknown as NfxVideo;
  };

  it('off: a play asks the worker for nothing', async () => {
    const w = world();
    await w.c.refreshSeeding();
    w.c.onPlay({ sid: SID, video: video(), peers: [] });
    await settle();
    expect(w.worker.count('seeding.watch')).toBe(0);
  });

  it('on: a play is handed over, with its signed manifest', async () => {
    const w = world();
    w.worker.answers['seeding.status'] = () => ({ ...IDLE, watched: true });
    w.worker.answers['seeding.watch'] = () => ({});
    await w.c.refreshSeeding();
    const v = video();
    w.c.onPlay({ sid: SID, video: v, peers: [] });
    await settle();
    const call = w.worker.calls.find((c) => c.m === 'seeding.watch');
    expect((call?.a as { manifest: { id: string } }).manifest.id).toBe(v.event.id);
    expect((call?.a as { sid: string }).sid).toBe(SID);
  });

  it('the switch goes through main, which asks the user', async () => {
    const w = world();
    w.worker.answers['app.seeding.set'] = () => IDLE;
    expect((await w.c.setSeeding(true)).watched).toBe(false);
    expect(w.worker.calls[0]).toEqual({ m: 'app.seeding.set', a: { on: true } });
    expect(w.worker.count('seeding.set')).toBe(0);
  });
});

describe('publishing', () => {
  const creator = new Key();
  const VIDEO_ID = `nutflix-${'b'.repeat(32)}`;

  /** What the worker answers the page, and the draft it keeps to itself until main asks. */
  function stored(): StudioPublishedWire & {
    readonly draft: Pick<NostrEvent, 'kind' | 'created_at' | 'tags' | 'content'>;
  } {
    const m = manifest(creator, VIDEO_ID, { createdAt: NOW, root: 'ab'.repeat(32), segs: 4 });
    return {
      video: `${NS}:${VIDEO_ID}`,
      files: 4,
      bytes: 100,
      draft: { kind: 38504, created_at: m.created_at, tags: m.tags, content: m.content },
    };
  }
  const input = {
    source: 'cd'.repeat(16),
    title: 'A title',
    description: '',
    tags: [],
    sizes: [720],
  };

  it('signs, verifies, and sends the manifest to the write and scoped relays', async () => {
    const w = world();
    const s = stored();
    const signed = creator.sign(s.draft);
    w.worker.answers['studio.publish'] = () => s;
    w.worker.answers['app.publish.sign'] = () => signed;
    const seen: string[] = [];
    const r = await w.c.publish(input, (p) => seen.push(p.stage));
    expect(r).toMatchObject({ video: s.video, relays: 2 });
    // The page names the draft. What gets signed is the worker's own record of it.
    expect(w.worker.calls.find((c) => c.m === 'app.publish.sign')?.a).toEqual({ video: s.video });
    expect(w.published[0]?.relays).toEqual([WRITE, SCOPED]);
    expect(w.published[0]?.event.id).toBe(signed.id);
  });

  it.each([
    ['tampered', (e: NostrEvent) => ({ ...e, content: 'changed' })],
    ['another video', () => creator.sign({ ...manifest(creator, 'another-video-1') })],
  ])('never publishes a signed manifest that is %s', async (_name, change) => {
    const w = world();
    const s = stored();
    w.worker.answers['studio.publish'] = () => s;
    w.worker.answers['app.publish.sign'] = () => change(creator.sign(s.draft));
    await expect(w.c.publish(input, () => undefined)).rejects.toThrow();
    expect(w.published).toEqual([]);
  });

  it('a signature that failed is asked for again without encoding again', async () => {
    const w = world();
    const s = stored();
    let tries = 0;
    w.worker.answers['studio.publish'] = () => s;
    w.worker.answers['app.publish.sign'] = () => {
      tries += 1;
      if (tries === 1) throw new Error('no-signer: the bunker did not answer');
      return creator.sign(s.draft);
    };
    await expect(w.c.publish(input, () => undefined)).rejects.toThrow(/bunker/);
    expect(w.c.awaitingSignature).toBe(true);
    expect(w.published).toEqual([]);
    await w.c.publish(input, () => undefined);
    expect(w.worker.count('studio.publish')).toBe(1);
    expect(w.worker.count('app.publish.sign')).toBe(2);
    expect(w.c.awaitingSignature).toBe(false);
    expect(w.published).toHaveLength(1);
  });

  it('a "no" in main’s dialog publishes nothing and leaves no draft to sign', async () => {
    const w = world();
    const s = stored();
    w.worker.answers['studio.publish'] = () => s;
    w.worker.answers['app.publish.sign'] = () => null;
    expect(await w.c.publish(input, () => undefined)).toBe(PUBLISH_DECLINED);
    expect(w.published).toEqual([]);
    expect(w.c.awaitingSignature).toBe(false);
    // Asking again is a new package: the old one is gone.
    await w.c.publish(input, () => undefined);
    expect(w.worker.count('studio.publish')).toBe(2);
  });

  it('stopping keeps the video; deleting and seeding again go through main', async () => {
    const w = world();
    const { video } = stored();
    w.worker.answers['seeding.stop'] = () => ({ stopped: true });
    w.worker.answers['app.seeding.delete'] = () => IDLE;
    w.worker.answers['app.seeding.resume'] = () => IDLE;
    await w.c.stopSeeding(video);
    expect(w.worker.calls.find((c) => c.m === 'seeding.stop')?.a).toEqual({ video });
    expect(w.worker.count('app.seeding.delete')).toBe(0);
    await w.c.deleteVideo(video);
    await w.c.resumeSeeding(video);
    expect(w.worker.calls.find((c) => c.m === 'app.seeding.delete')?.a).toEqual({ video });
    expect(w.worker.calls.find((c) => c.m === 'app.seeding.resume')?.a).toEqual({ video });
  });

  it('a changed title is a new package, never a re-signed old one', async () => {
    const w = world();
    const s = stored();
    let tries = 0;
    w.worker.answers['studio.publish'] = () => s;
    w.worker.answers['app.publish.sign'] = () => {
      tries += 1;
      if (tries === 1) throw new Error('no-signer: locked');
      return creator.sign(s.draft);
    };
    await expect(w.c.publish(input, () => undefined)).rejects.toThrow();
    await w.c.publish({ ...input, title: 'Another title' }, () => undefined);
    expect(w.worker.count('studio.publish')).toBe(2);
  });

  it('progress reaches the caller only during its own publish', async () => {
    const w = world();
    const s = stored();
    w.worker.answers['studio.publish'] = () => {
      w.worker.emit({ op: 'ev', e: 'studio.progress', stage: 'encoding', percent: 50 });
      return s;
    };
    w.worker.answers['app.publish.sign'] = () => creator.sign(s.draft);
    const seen: number[] = [];
    await w.c.publish(input, (p) => seen.push(p.percent ?? -1));
    w.worker.emit({ op: 'ev', e: 'studio.progress', stage: 'encoding', percent: 99 });
    expect(seen).toEqual([50]);
  });
});

describe('the segment tap', () => {
  const sha = async (b: Uint8Array): Promise<string> => {
    const d = await crypto.subtle.digest('SHA-256', b as unknown as ArrayBuffer);
    return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join('');
  };

  function tapped(on = true): {
    tap: SegmentTap;
    worker: FakeControl;
    proto: { appendBuffer(this: unknown, d: BufferSource): void };
    appended: unknown[];
  } {
    const worker = new FakeControl();
    worker.answers['seeding.segment'] = () => ({ accepted: true, complete: false });
    const appended: unknown[] = [];
    const proto = {
      appendBuffer(this: unknown, d: BufferSource): void {
        appended.push(d);
      },
    };
    const tap = new SegmentTap({ worker, enabled: () => on, sha256: sha });
    tap.install(proto);
    return { tap, worker, proto, appended };
  }

  it('hands over what the player verified, in order, in bounded chunks', async () => {
    const t = tapped();
    const bytes = new Uint8Array(TAP_CHUNK_BYTES * 2 + 10).map((_, i) => i % 251);
    const hash = await sha(bytes);
    t.tap.verified(hash, SID);
    t.proto.appendBuffer(bytes);
    await vi.waitFor(() => {
      expect(t.worker.count('seeding.segment')).toBe(3);
    });
    const sent = t.worker.calls.map(
      (c) => c.a as { sid: string; sha256: string; size: number; offset: number; data: string },
    );
    expect(sent.map((a) => a.offset)).toEqual([0, TAP_CHUNK_BYTES, TAP_CHUNK_BYTES * 2]);
    for (const a of sent) expect(a).toMatchObject({ sid: SID, sha256: hash, size: bytes.length });
    expect(sent[0]?.data).toBe(toBase64(bytes.subarray(0, TAP_CHUNK_BYTES)));
    // The player's own append ran, with its own buffer.
    expect(t.appended).toEqual([bytes]);
  });

  it('hands over nothing the player did not verify', async () => {
    const t = tapped();
    t.tap.verified(SHA, SID);
    t.proto.appendBuffer(new Uint8Array(64).fill(3));
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.worker.calls).toEqual([]);
  });

  it('with seeding off, it hashes and sends nothing', async () => {
    const t = tapped(false);
    const bytes = new Uint8Array(64).fill(3);
    t.tap.verified(await sha(bytes), SID);
    t.proto.appendBuffer(bytes);
    await settle();
    expect(t.worker.calls).toEqual([]);
  });

  it('forgets a play that ended', async () => {
    const t = tapped();
    const bytes = new Uint8Array(64).fill(4);
    t.tap.verified(await sha(bytes), SID);
    t.tap.ended(SID);
    t.proto.appendBuffer(bytes);
    await settle();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.worker.calls).toEqual([]);
  });

  it('stops sending a file the worker refuses, and never breaks playback', async () => {
    const t = tapped();
    t.worker.answers['seeding.segment'] = () => ({ accepted: false, complete: false });
    const bytes = new Uint8Array(TAP_CHUNK_BYTES * 3).fill(5);
    t.tap.verified(await sha(bytes), SID);
    t.proto.appendBuffer(bytes);
    await vi.waitFor(() => {
      expect(t.worker.count('seeding.segment')).toBe(1);
    });
    await settle();
    expect(t.worker.count('seeding.segment')).toBe(1);

    const failing = tapped();
    failing.tap.verified(SHA, SID);
    failing.worker.answers['seeding.segment'] = () => {
      throw new Error('worker down');
    };
    expect(() => {
      failing.proto.appendBuffer(new Uint8Array(8));
    }).not.toThrow();
    expect(failing.appended).toHaveLength(1);
  });

  it('holds a bounded number of files at once', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const worker = new FakeControl();
    let hashed = 0;
    const tap = new SegmentTap({
      worker,
      enabled: () => true,
      sha256: async () => {
        hashed += 1;
        await gate;
        return SHA;
      },
    });
    tap.verified(SHA, SID);
    for (let i = 0; i < MAX_TAP_PENDING + 5; i++) tap.appended(new Uint8Array(8));
    await settle();
    expect(hashed).toBe(MAX_TAP_PENDING);
    release();
    await settle();
  });

  it('restores the original appendBuffer', () => {
    const worker = new FakeControl();
    const original = function (this: unknown): void {
      // The browser's.
    };
    const proto = { appendBuffer: original as (d: BufferSource) => void };
    const tap = new SegmentTap({ worker, enabled: () => true });
    tap.install(proto);
    expect(proto.appendBuffer).not.toBe(original);
    tap.uninstall();
    expect(proto.appendBuffer).toBe(original);
  });
});

describe('the Settings section', () => {
  const running: { client: RendererClient; container: HTMLElement }[] = [];
  afterEach(async () => {
    for (const { client, container } of running.splice(0)) {
      await act(async () => {
        await client.stop();
      });
      container.remove();
    }
    window.history.replaceState(null, '', '/');
  });

  const idlePipe = (): WorkerPipe & { readonly written: Uint8Array[] } => {
    const written: Uint8Array[] = [];
    return {
      written,
      write: (b) => void written.push(b),
      onData: () => () => undefined,
      onClose: () => () => undefined,
      close: () => undefined,
    };
  };

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => {
          setTimeout(r, 0);
        });
      }
    });
  }

  async function show(hash: string): Promise<HTMLElement> {
    window.history.replaceState(null, '', hash);
    const container = document.createElement('div');
    document.body.appendChild(container);
    let client: RendererClient | undefined;
    act(() => {
      client = startRenderer({
        container,
        pipe: idlePipe(),
        pool: new FakeRelayPool(),
        settings: new SettingsStore({ storage: null }),
        fetch: () => Promise.resolve(new Response('', { status: 404 })),
      });
    });
    if (client === undefined) throw new Error('not started');
    running.push({ client, container });
    await flush();
    return container;
  }

  it('is shown in Settings only, with the switch off and the disclosure in plain text', async () => {
    const home = await show('/#/');
    expect(home.querySelector(`#${PANEL_ID}`)).toBeNull();
    const c = await show('/#/settings');
    const s = c.querySelector<HTMLInputElement>('#nutflix-seed-switch');
    expect(s?.checked).toBe(false);
    expect(s?.getAttribute('role')).toBe('switch');
    expect(c.querySelector('#nutflix-seed-disclosure')?.textContent).toBe(SEEDING_DISCLOSURE);
    expect(SEEDING_DISCLOSURE).toContain('shares your IP address with viewers');
    expect(c.querySelector<HTMLButtonElement>('#nutflix-publish')?.disabled).toBe(true);
  });

  it('has no file input: the file comes from main’s native dialog', async () => {
    const c = await show('/#/settings');
    expect(c.querySelector(`#${PANEL_ID} input[type="file"]`)).toBeNull();
  });

  it('has no field and no button for a secret: it points at the Account menu', async () => {
    const worker = new FakeControl();
    worker.answers['seeding.status'] = () => IDLE;
    let status: SignerStatusWire = SIGNER;
    worker.answers['signer.status'] = () => status;
    worker.answers['studio.ffmpeg'] = () => ({ found: true, install: 'x' });
    const control = new SeedPublish({
      worker,
      pool: { publish: () => Promise.resolve([]) },
      settings: { get: () => settings },
    });
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'nf-settings__body';
    root.append(body);
    document.body.append(root);
    const panel = installSeedPublishPanel(root, control);
    await settle();
    expect(root.querySelector('input[type="password"]')).toBeNull();
    for (const id of ['passphrase', 'bunker', 'signer-create', 'signer-unlock', 'signer-connect'])
      expect(root.querySelector(`#nutflix-${id}`)).toBeNull();
    expect(root.querySelector('#nutflix-signer-lock')).toBeNull();
    expect(root.querySelector('#nutflix-signer-note')?.textContent).toBe(ACCOUNT_MENU_NOTE);
    expect(ACCOUNT_MENU_NOTE).toContain('use the Account menu');
    expect(ACCOUNT_MENU_NOTE).toContain('never asks');
    expect(worker.calls.some((c) => c.m.startsWith('app.signer'))).toBe(false);

    // The menu changed the signer: the page hears only that, and reads the status again.
    status = {
      kind: 'local',
      pubkey: 'ab'.repeat(32),
      locked: false,
      keyFile: true,
      localAllowed: true,
    };
    worker.emit({ op: 'ev', e: SIGNER_EVENT, changed: true });
    await settle();
    expect(root.querySelector('#nutflix-signer-status')?.textContent).toContain('unlocked');
    panel.stop();
    root.remove();
  });

  it('without the sandbox, says why a key on this computer is not used', async () => {
    const worker = new FakeControl();
    worker.answers['seeding.status'] = () => IDLE;
    worker.answers['signer.status'] = () => ({ ...SIGNER, keyFile: true, localAllowed: false });
    worker.answers['studio.ffmpeg'] = () => ({ found: true, install: 'x' });
    const control = new SeedPublish({
      worker,
      pool: { publish: () => Promise.resolve([]) },
      settings: { get: () => settings },
    });
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'nf-settings__body';
    root.append(body);
    document.body.append(root);
    const panel = installSeedPublishPanel(root, control);
    await settle();
    const line = root.querySelector('#nutflix-signer-status');
    expect(line?.textContent).toContain('without Chromium');
    expect(line?.textContent).toContain('untouched');
    expect((line as HTMLElement).dataset['localAllowed']).toBe('false');
    panel.stop();
    root.remove();
  });

  it('a stored video has Stop and Delete; Stop never deletes', async () => {
    const worker = new FakeControl();
    const v = servedStatus().videos[0];
    if (v === undefined) throw new Error('no video');
    let status: SeedingStatusWire = servedStatus();
    worker.answers['seeding.status'] = () => status;
    worker.answers['seeding.beacons'] = () => ({ events: [] });
    worker.answers['signer.status'] = () => SIGNER;
    worker.answers['studio.ffmpeg'] = () => ({ found: true, install: 'x' });
    worker.answers['seeding.stop'] = () => {
      status = {
        ...status,
        videos: [{ ...v, served: false, stopped: true }],
        listening: [],
      };
      return { stopped: true };
    };
    worker.answers['app.seeding.delete'] = () => IDLE;
    const control = new SeedPublish({
      worker,
      pool: { publish: () => Promise.resolve([]) },
      settings: { get: () => settings },
      timers: { setInterval: () => 1, clearInterval: () => undefined },
    });
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'nf-settings__body';
    root.append(body);
    document.body.append(root);
    const panel = installSeedPublishPanel(root, control);
    await settle();
    root.querySelector<HTMLButtonElement>('#nutflix-seed-stop-0')?.click();
    await settle();
    expect(worker.calls.find((c) => c.m === 'seeding.stop')?.a).toEqual({ video: v.video });
    expect(worker.count('app.seeding.delete')).toBe(0);
    expect(root.querySelector('#nutflix-seed-stop-0')).toBeNull();
    expect(root.querySelector('#nutflix-seed-resume-0')).not.toBeNull();
    root.querySelector<HTMLButtonElement>('#nutflix-seed-delete-0')?.click();
    await settle();
    expect(worker.calls.find((c) => c.m === 'app.seeding.delete')?.a).toEqual({ video: v.video });
    panel.stop();
    root.remove();
  });

  it('says how to install ffmpeg when it is missing', async () => {
    const worker = new FakeControl();
    worker.answers['seeding.status'] = () => IDLE;
    worker.answers['signer.status'] = () => SIGNER;
    worker.answers['studio.ffmpeg'] = () => ({
      found: false,
      install: 'Install ffmpeg with Homebrew: brew install ffmpeg',
    });
    const control = new SeedPublish({
      worker,
      pool: { publish: () => Promise.resolve([]) },
      settings: { get: () => settings },
    });
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'nf-settings__body';
    root.append(body);
    document.body.append(root);
    const panel = installSeedPublishPanel(root, control);
    await settle();
    expect(root.querySelector('#nutflix-ffmpeg')?.textContent).toContain('brew install ffmpeg');
    expect(root.querySelector<HTMLButtonElement>('#nutflix-pick')?.disabled).toBe(true);
    panel.stop();
    root.remove();
  });

  it('turning the switch on leaves it off until the worker says otherwise', async () => {
    const worker = new FakeControl();
    worker.answers['seeding.status'] = () => IDLE;
    worker.answers['signer.status'] = () => SIGNER;
    worker.answers['studio.ffmpeg'] = () => ({ found: true, install: 'x' });
    // The user answered "Keep it off" in main's dialog.
    worker.answers['app.seeding.set'] = () => IDLE;
    const control = new SeedPublish({
      worker,
      pool: { publish: () => Promise.resolve([]) },
      settings: { get: () => settings },
    });
    const root = document.createElement('div');
    const body = document.createElement('div');
    body.className = 'nf-settings__body';
    root.append(body);
    document.body.append(root);
    const panel = installSeedPublishPanel(root, control);
    await settle();
    const s = root.querySelector<HTMLInputElement>('#nutflix-seed-switch');
    s?.click();
    await settle();
    expect(worker.calls.find((c) => c.m === 'app.seeding.set')?.a).toEqual({ on: true });
    expect(s?.checked).toBe(false);
    panel.stop();
    root.remove();
  });
});
