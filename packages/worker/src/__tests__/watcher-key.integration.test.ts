/**
 * The watcher key (`../keys.ts` `WatcherKeys`), on a local hyperdht testnet against nutflix-pear's
 * own NFX-12 listener: what a seeder sees.
 *
 *   - two runs of the worker on the same storage dial with two different public keys, so a seeder
 *     cannot link one viewer's plays across runs by the key (nutflix-pear ADR 0023 §3);
 *   - within a run, every dial uses that run's key (per run, not per play: `../keys.ts` says why);
 *   - nothing about the watcher key reaches storage: no file under it holds the public key, the
 *     secret key or its seed, raw, hex or base64, and the keyring is never asked for a watcher
 *     name; at shutdown the secret key is overwritten.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { hyperdhtEndpoint, listenNfx } from '@sovit/seeder';
import DHT from 'hyperdht';
import createTestnet from 'hyperdht/testnet.js';
import type { Testnet } from 'hyperdht/testnet.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Keyring } from '../keys.js';
import { WatcherKeys, openCorestoreKeyring } from '../keys.js';
import { startWorker, tempDir } from './helpers/harness.js';
import { memorySource, vectorVideo } from './helpers/nfx-video.js';

vi.setConfig({ testTimeout: 120_000 });

const SEEDER_NOSTR = 'ab'.repeat(32);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

/** Every file under `dir`, by path. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

describe('WatcherKeys', () => {
  it('one random pair per network, the same within the run, overwritten at close', async () => {
    const keys = new WatcherKeys();
    const a = await keys.keyPair('nfx:a');
    expect(await keys.keyPair('nfx:a')).toBe(a);
    const b = await keys.keyPair('nfx:b');
    expect(hex(b.publicKey)).not.toBe(hex(a.publicKey));
    // A libsodium Ed25519 pair: the secret key's second half is the public key.
    expect(hex(a.secretKey.subarray(32))).toBe(hex(a.publicKey));
    expect(a.publicKey).toHaveLength(32);
    const other = await new WatcherKeys().keyPair('nfx:a');
    expect(hex(other.publicKey)).not.toBe(hex(a.publicKey));

    keys.close();
    expect(a.secretKey.every((x) => x === 0)).toBe(true);
    expect(b.secretKey.every((x) => x === 0)).toBe(true);
    await expect(keys.keyPair('nfx:a')).rejects.toThrow(/^backend-down/);
  });

  it.each([[''], ['x'.repeat(161)]])('refuses %j as a network', async (ns) => {
    await expect(new WatcherKeys().keyPair(ns)).rejects.toThrow(/^invalid-argument/);
  });
});

describe('the worker dials with a fresh watcher key every run', () => {
  let testnet: Testnet;
  const cleanups: (() => Promise<void>)[] = [];

  beforeEach(async () => {
    testnet = await createTestnet(3);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const c of cleanups.splice(0).reverse()) await c();
    await testnet.destroy();
  });

  it('two runs on one storage: two keys a seeder sees, one per run, none stored', async () => {
    const v = vectorVideo();
    // What the seeder is dialed with, in order: the remote key its firewall is asked about.
    const seen: string[] = [];
    // Bound to 127.0.0.1, as the worker's node is on a loopback testnet: on one host, hyperdht
    // connects two peers only when they bind alike (`src/net/no-local-addresses.ts`).
    const seederDht = new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' });
    cleanups.push(() => seederDht.destroy());
    await seederDht.fullyBootstrapped();
    const seederKey = DHT.keyPair();
    const listener = await listenNfx(seederDht, {
      keyPair: seederKey,
      source: memorySource(v.files, v.video),
      firewall: (remotePublicKey) => {
        seen.push(hex(remotePublicKey));
        return false;
      },
    });
    cleanups.push(() => listener.close());
    const peer = hyperdhtEndpoint(seederKey, SEEDER_NOSTR, v.namespace);

    // Every key pair a dial of this process used: a copy of its secret key (the original is
    // overwritten at close), and the original, to see that it was.
    const copies = new Map<string, Buffer>();
    const originals: Uint8Array[] = [];
    const proto = DHT.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    const realConnect = proto['connect'];
    if (realConnect === undefined) throw new Error('no hyperdht connect');
    vi.spyOn(DHT.prototype, 'connect').mockImplementation(function (this: DHT, key, opts) {
      const kp = opts?.keyPair;
      if (kp !== undefined && !copies.has(hex(kp.publicKey))) {
        copies.set(hex(kp.publicKey), Buffer.from(kp.secretKey));
        originals.push(kp.secretKey);
      }
      return Reflect.apply(realConnect, this, [key, opts]) as ReturnType<DHT['connect']>;
    });

    const d = await tempDir('nf-watcher-');
    cleanups.push(() => d.rm());
    const asked: string[] = [];
    const recording = async (dir: string): Promise<Keyring> => {
      const k = await openCorestoreKeyring(dir);
      return {
        keyPair: (name) => {
          asked.push(name);
          return k.keyPair(name);
        },
        close: () => k.close(),
      };
    };
    const init = { v: 1, storage: d.dir, bootstrap: testnet.bootstrap } as const;

    const perRun: string[][] = [];
    for (let run = 0; run < 2; run++) {
      const w = startWorker({ openKeyring: recording });
      cleanups.push(() => w.close());
      await w.client.request('init', init);
      const before = seen.length;
      // Two plays, one after the other: the second dials again (the first's connection is gone).
      for (let play = 0; play < 2; play++) {
        const sid = randomBytes(16).toString('hex');
        await w.client.request('nfx.play.open', {
          sid,
          video: v.video,
          root: v.root,
          segs: v.segs,
          peers: [peer],
          progressive: false,
        });
        await w.client.request('nfx.play.close', { sid });
      }
      perRun.push(seen.slice(before));
      await w.close();
      expect(w.fatal).toEqual([]);
    }

    const [first = [], second = []] = perRun;
    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(second.length).toBeGreaterThanOrEqual(2);
    expect(new Set(first).size).toBe(1);
    expect(new Set(second).size).toBe(1);
    expect(first[0]).not.toBe(second[0]);
    // The keys the seeder saw are the keys this process dialed with.
    expect([...copies.keys()].sort()).toEqual([first[0], second[0]].sort());

    // Nothing of either key is on disk, in any encoding, and no watcher name was ever derived.
    expect(asked.filter((n) => n.includes('watcher'))).toEqual([]);
    const files = filesUnder(d.dir);
    expect(files.some((f) => f.includes(join(d.dir, 'keys')))).toBe(true);
    const needles: Buffer[] = [];
    for (const [pub, secret] of copies) {
      const raw = Buffer.from(pub, 'hex');
      const seed = secret.subarray(0, 32);
      for (const b of [raw, secret, seed])
        needles.push(b, Buffer.from(b.toString('hex')), Buffer.from(b.toString('base64')));
    }
    for (const f of files) {
      const bytes = readFileSync(f);
      for (const n of needles) expect(bytes.indexOf(n), f).toBe(-1);
    }
    // And the secret keys themselves were overwritten when each run closed.
    expect(originals).toHaveLength(2);
    for (const sk of originals) expect(sk.every((x) => x === 0)).toBe(true);
  });
});
