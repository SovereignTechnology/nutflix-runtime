/**
 * The user's signer (ADR 0001 §8), through the real wire and guards: a passphrase-sealed key held
 * by the worker and a throwaway NIP-46 bunker on loopback. What must hold: a wrong passphrase is
 * refused, a key or passphrase never crosses the wire, only allow-listed kinds are signed, and
 * only a manifest of a video this node packaged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { signer as coreSigner, nfx } from '@sovit/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkerError } from '../errors.js';
import type { UnsignedEventWire } from '../protocol.js';
import type { RelayConnect } from '../runtime.js';
import { parseBunkerUri } from '../signer/bunker.js';
import { BunkerRelayPool, MAX_RELAY_MESSAGES_PER_SECOND } from '../signer/relay-pool.js';
import { KEY_FILE, SIGNER_DIR, UserSigner, unlockBackoffMs } from '../signer/user-signer.js';
import {
  nodeRuntime,
  nodeSystem,
  startWorker,
  tempDir,
  type RunningWorker,
} from './helpers/harness.js';
import { LoopRelay, TestBunker } from './helpers/test-bunker.js';
import { nodeFs } from '@sovit/seeder';

vi.setConfig({ testTimeout: 60_000 });

const PASS = 'correct horse battery staple';
const cost = coreSigner.minimumCost();

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function worker(): Promise<{ w: RunningWorker; dir: string }> {
  const d = await tempDir('nf-signer-');
  cleanups.push(() => d.rm());
  const w = startWorker({ runtime: nodeRuntime(nodeSystem()), signerCost: cost });
  cleanups.push(() => w.close());
  await w.client.request('init', {
    v: 1,
    storage: d.dir,
    bootstrap: [{ host: '127.0.0.1', port: 9 }],
  });
  return { w, dir: d.dir };
}

const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof WorkerError ? e.code : 'not-a-worker-error';
  }
};

const draft = (over: Partial<UnsignedEventWire> = {}): UnsignedEventWire => ({
  kind: 38504,
  created_at: 1_800_000_000,
  tags: [
    ['d', `nfx:testnet:1:nutflix-${'a'.repeat(32)}`],
    ['n', 'nfx:testnet:1'],
    ['title', 'x'],
    ['published_at', '1800000000'],
    ['license', 'open'],
    ['root', 'ab'.repeat(32)],
    ['segs', '4'],
  ],
  content: '',
  ...over,
});

describe('the passphrase-sealed key', () => {
  it('starts with none; a new key is sealed, usable, and locks', async () => {
    const { w, dir } = await worker();
    expect(await w.client.request('signer.status', {})).toEqual({
      kind: 'none',
      pubkey: null,
      locked: true,
      keyFile: false,
    });
    const made = await w.client.request('signer.local.create', { passphrase: PASS });
    expect(made.kind).toBe('local');
    expect(made.locked).toBe(false);
    expect(made.pubkey).toMatch(/^[0-9a-f]{64}$/);
    const file = readFileSync(join(dir, SIGNER_DIR, KEY_FILE));
    expect(coreSigner.readKeyFileHeader(file).pubkey).toBe(made.pubkey);
    expect(file.toString('utf8')).not.toContain(PASS);
    const locked = await w.client.request('signer.lock', {});
    expect(locked).toMatchObject({ kind: 'local', locked: true, pubkey: made.pubkey });
    expect(await codeOf(w.client.request('signer.local.create', { passphrase: PASS }))).toBe(
      'exists',
    );
  });

  it('refuses a wrong passphrase, and opens with the right one', async () => {
    const { w } = await worker();
    const made = await w.client.request('signer.local.create', { passphrase: PASS });
    await w.client.request('signer.lock', {});
    expect(
      await codeOf(w.client.request('signer.local.unlock', { passphrase: 'not the passphrase' })),
    ).toBe('bad-passphrase');
    expect((await w.client.request('signer.status', {})).locked).toBe(true);
    const open = await w.client.request('signer.local.unlock', { passphrase: PASS });
    expect(open).toMatchObject({ locked: false, pubkey: made.pubkey });
  });

  it('waits longer after each wrong passphrase', async () => {
    expect([1, 2, 3, 4, 9, 40].map(unlockBackoffMs)).toEqual([0, 1000, 2000, 4000, 60_000, 60_000]);
    const d = await tempDir('nf-signer-');
    cleanups.push(() => d.rm());
    let t = 1_000_000;
    const s = new UserSigner({
      fs: nodeFs,
      system: nodeSystem(),
      dir: join(d.dir, SIGNER_DIR),
      cost,
      now: () => t,
    });
    await s.load();
    await s.create(PASS);
    await s.lock();
    const wrong = 'not the passphrase';
    expect(await codeOf(s.unlock(wrong))).toBe('bad-passphrase');
    expect(await codeOf(s.unlock(wrong))).toBe('bad-passphrase');
    // The third try comes within the wait: refused before the KDF, even with the right passphrase.
    expect(await codeOf(s.unlock(PASS))).toBe('rate-limited');
    t += 1001;
    expect((await s.unlock(PASS)).locked).toBe(false);
    await s.close();
  });

  it('never puts the passphrase on the wire back, in an answer, an event or a log', async () => {
    const { w } = await worker();
    const secret = 'a very distinctive passphrase 8841';
    const r1 = await w.client.request('signer.local.create', { passphrase: secret });
    await w.client.request('signer.lock', {});
    const failed = await w.client
      .request('signer.local.unlock', { passphrase: `${secret}x` })
      .catch((e: unknown) => String(e));
    const r2 = await w.client.request('signer.local.unlock', { passphrase: secret });
    const all = JSON.stringify([r1, r2, failed, w.events]);
    expect(all).not.toContain('distinctive');
  });

  it('stays locked when Lock is pressed while an unlock is running', async () => {
    const d = await tempDir('nf-signer-');
    cleanups.push(() => d.rm());
    const s = new UserSigner({
      fs: nodeFs,
      system: nodeSystem(),
      dir: join(d.dir, SIGNER_DIR),
      cost,
    });
    await s.load();
    await s.create(PASS);
    await s.lock();
    const running = s.unlock(PASS);
    await s.lock();
    expect((await running).locked).toBe(true);
    expect(await codeOf(s.sign(draft()))).toBe('no-signer');
    await s.close();
  });

  it('holds only public key material in what it reports', async () => {
    const { w } = await worker();
    const s = await w.client.request('signer.local.create', { passphrase: PASS });
    expect(Object.keys(s).sort()).toEqual(['keyFile', 'kind', 'locked', 'pubkey']);
  });
});

describe('what may be signed', () => {
  it.each([0, 1, 3, 4, 5, 7, 1059, 10002, 13194, 20464, 23194, 24133, 30078, 38503])(
    'refuses kind %i at the guard',
    async (kind) => {
      const { w } = await worker();
      await w.client.request('signer.local.create', { passphrase: PASS });
      expect(await codeOf(w.client.request('signer.sign', { event: draft({ kind }) }))).toBe(
        'invalid-argument',
      );
    },
  );

  it('refuses a manifest of a video this node did not package', async () => {
    const { w } = await worker();
    await w.client.request('signer.local.create', { passphrase: PASS });
    expect(await codeOf(w.client.request('signer.sign', { event: draft() }))).toBe(
      'invalid-argument',
    );
  });

  it('refuses a malformed event', async () => {
    const { w } = await worker();
    await w.client.request('signer.local.create', { passphrase: PASS });
    const bad: unknown[] = [
      { ...draft(), extra: 1 },
      { ...draft(), pubkey: 'ab'.repeat(32) },
      { ...draft(), created_at: -1 },
      { ...draft(), created_at: 1.5 },
      { ...draft(), tags: 'x' },
      { ...draft(), tags: [[]] },
      { ...draft(), tags: Array.from({ length: 129 }, () => ['t', 'x']) },
      { ...draft(), tags: [['t', 'x'.repeat(1025)]] },
      { ...draft(), content: 'x'.repeat(8193) },
      { ...draft(), content: 7 },
    ];
    for (const event of bad)
      expect(
        await codeOf(w.client.request('signer.sign', { event } as never)),
        JSON.stringify(event).slice(0, 60),
      ).toBe('invalid-argument');
  });

  it('with no signer, says so', async () => {
    const d = await tempDir('nf-signer-');
    cleanups.push(() => d.rm());
    const s = new UserSigner({ fs: nodeFs, system: nodeSystem(), dir: join(d.dir, 's'), cost });
    await s.load();
    expect(await codeOf(s.sign(draft()))).toBe('no-signer');
  });
});

describe('a NIP-46 bunker on loopback', () => {
  async function bunker(o: { evil?: boolean; secret?: string } = {}): Promise<{
    relay: LoopRelay;
    b: TestBunker;
    s: UserSigner;
  }> {
    const relay = await LoopRelay.start();
    cleanups.push(() => relay.close());
    const b = await TestBunker.start(relay.url, o);
    cleanups.push(() => {
      b.close();
    });
    const d = await tempDir('nf-signer-');
    cleanups.push(() => d.rm());
    const s = new UserSigner({
      fs: nodeFs,
      system: nodeSystem(),
      dir: join(d.dir, 's'),
      cost,
      bunkerWaitMs: 5000,
    });
    await s.load();
    cleanups.push(() => s.close());
    return { relay, b, s };
  }

  it('connects, learns the user key, and signs what was asked', async () => {
    const { b, s } = await bunker({ secret: 'one-time-secret' });
    const st = await s.connect(b.uri);
    expect(st).toMatchObject({ kind: 'nip46', pubkey: b.userPubkey, locked: false });
    expect(JSON.stringify(st)).not.toContain('one-time-secret');
    const signed = await s.sign(draft({ content: 'hello' }));
    expect(signed.pubkey).toBe(b.userPubkey);
    expect(signed.content).toBe('hello');
    expect(nfx.verifyEvent(signed).ok).toBe(true);
    expect(b.signedKinds).toEqual([38504]);
    expect((await s.lock()).kind).toBe('none');
    expect(await codeOf(s.sign(draft()))).toBe('no-signer');
  });

  it('refuses a bunker that returns a different event than the one asked for', async () => {
    const { b, s } = await bunker({ evil: true });
    await s.connect(b.uri);
    expect(await codeOf(s.sign(draft({ content: 'what I asked for' })))).toBe('no-signer');
  });

  it('refuses the wrong secret', async () => {
    const { b, s } = await bunker({ secret: 'right' });
    const wrong = b.uri.replace('secret=right', 'secret=wrong');
    expect(await codeOf(s.connect(wrong))).toBe('no-signer');
    expect(s.status().kind).toBe('none');
  });

  describe('a hostile relay', () => {
    const KEY = 'ab'.repeat(32);

    function socket(): {
      connect: RelayConnect;
      say: (m: unknown) => void;
      destroyed: () => boolean;
    } {
      let onMessage: (text: string) => void = () => undefined;
      let destroyed = false;
      return {
        connect: () => ({
          onMessage: (cb) => {
            onMessage = cb;
          },
          onEnd: () => undefined,
          send: () => undefined,
          destroy: () => {
            destroyed = true;
          },
        }),
        say: (m) => {
          onMessage(JSON.stringify(m));
        },
        destroyed: () => destroyed,
      };
    }

    it('is dropped for an event the filter did not ask for', () => {
      const r = socket();
      const pool = new BunkerRelayPool(r.connect);
      const onevent = vi.fn();
      pool.subscribe(['wss://r.example'], { kinds: [24133], authors: [KEY] }, { onevent });
      r.say(['EVENT', 'nip46-1', { kind: 24133, pubkey: 'cd'.repeat(32) }]);
      expect(r.destroyed()).toBe(true);
      expect(onevent).not.toHaveBeenCalled();
    });

    it('is dropped for an event that does not verify', () => {
      const r = socket();
      const pool = new BunkerRelayPool(r.connect);
      const onevent = vi.fn();
      pool.subscribe(['wss://r.example'], { kinds: [24133], authors: [KEY] }, { onevent });
      r.say([
        'EVENT',
        'nip46-1',
        {
          id: '00'.repeat(32),
          kind: 24133,
          pubkey: KEY,
          created_at: 1,
          tags: [],
          content: '',
          sig: '00'.repeat(64),
        },
      ]);
      expect(r.destroyed()).toBe(true);
      expect(onevent).not.toHaveBeenCalled();
    });

    it('is dropped for a flood of messages', () => {
      const r = socket();
      const pool = new BunkerRelayPool(r.connect);
      pool.subscribe(['wss://r.example'], { kinds: [24133] }, { onevent: () => undefined });
      for (let i = 0; i <= MAX_RELAY_MESSAGES_PER_SECOND; i++) r.say(['NOTICE', 'x']);
      expect(r.destroyed()).toBe(true);
    });
  });

  it.each([
    ['no scheme', `${'ab'.repeat(32)}?relay=wss://r.example`],
    ['another scheme', `nostrconnect://${'ab'.repeat(32)}?relay=wss://r.example`],
    ['a short key', `bunker://abcd?relay=wss://r.example`],
    ['uppercase hex', `bunker://${'AB'.repeat(32)}?relay=wss://r.example`],
    ['no relay', `bunker://${'ab'.repeat(32)}?secret=x`],
    ['ws to a remote host', `bunker://${'ab'.repeat(32)}?relay=ws://r.example`],
    ['http', `bunker://${'ab'.repeat(32)}?relay=https://r.example`],
    ['credentials', `bunker://${'ab'.repeat(32)}?relay=wss://u:p@r.example`],
    ['an unknown parameter', `bunker://${'ab'.repeat(32)}?relay=wss://r.example&x=1`],
    [
      'too many relays',
      `bunker://${'ab'.repeat(32)}?${Array.from({ length: 5 }, (_, i) => `relay=wss://r${String(i)}.example`).join('&')}`,
    ],
  ])('refuses a URI with %s', (_name, uri) => {
    expect(() => parseBunkerUri(uri)).toThrow(/^invalid-argument: /);
  });

  it('takes a wss relay, and ws only to loopback', () => {
    const pk = 'ab'.repeat(32);
    expect(parseBunkerUri(`bunker://${pk}?relay=wss://r.example&secret=s`)).toEqual({
      pubkey: pk,
      relays: ['wss://r.example'],
      secret: 's',
    });
    expect(parseBunkerUri(`bunker://${pk}?relay=ws://127.0.0.1:7777`).relays).toEqual([
      'ws://127.0.0.1:7777',
    ]);
  });
});
