/**
 * The updater's swarm (`../update/swarm.ts`) on a private testnet on 127.0.0.1: its key pair is new
 * on every run, a valid Ed25519 pair, and not the store-derived key `pear-runtime` would use. The
 * release-root branch (the public DHT) is not built here: no test reaches the public network.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import Corestore from 'corestore';
import createTestnet from 'hyperdht/testnet.js';
import { describe, expect, it } from 'vitest';

import { updaterSwarm } from '../update/swarm.ts';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe("the updater's swarm", () => {
  it('dials with a new key pair every run, never one derived from the store', async () => {
    const testnet = await createTestnet(3);
    const dir = mkdtempSync(join(tmpdir(), 'nf-upd-'));
    const store = new Corestore(dir);
    try {
      await store.ready();
      // What pear-runtime 1.3.1 would dial with, from the same store on every run.
      const derived = hex((await store.createKeyPair('pear-runtime')).publicKey);
      const runs = [updaterSwarm(testnet.bootstrap), updaterSwarm(testnet.bootstrap)];
      try {
        const keys = runs.map((s) => s.keyPair);
        for (const kp of keys) {
          expect(kp.publicKey).toHaveLength(32);
          expect(hex(kp.secretKey.subarray(32))).toBe(hex(kp.publicKey));
          expect(hex(kp.publicKey)).not.toBe(derived);
        }
        const [first, second] = keys;
        if (first === undefined || second === undefined) throw new Error('two runs, two swarms');
        expect(hex(first.publicKey)).not.toBe(hex(second.publicKey));
      } finally {
        for (const s of runs) await s.destroy();
      }
    } finally {
      await store.close();
      rmSync(dir, { recursive: true, force: true });
      await testnet.destroy();
    }
  });
});
