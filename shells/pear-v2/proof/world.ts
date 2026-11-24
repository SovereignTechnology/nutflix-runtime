/**
 * What the app meets in the proof, all on 127.0.0.1: nutflix-pear's own NFX-12 seeder on the private
 * DHT, serving a real VP9 package ffmpeg made, and a local relay holding a really signed manifest
 * whose title and description are an HTML injection.
 */
import { createHash } from 'node:crypto';

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import DHT from 'hyperdht';

import type { NostrEvent } from '@sovit/core';
import { beaconTags } from '@sovit/core/nfx';
import { hyperdhtEndpoint, listenNfx, type NfxFileSource } from '@sovit/seeder';

import { TestRelay } from '../../../packages/renderer/e2e/helpers/relay.ts';
import { makeVp9Package } from '../../../packages/renderer/e2e/helpers/vp9-nfx.ts';
import type { DhtNode } from './platform-modules.ts';

export const NS = 'nfx:testnet:1';

/** What a stranger would publish: it must reach the screen as these exact characters. */
export const HOSTILE_TITLE = '<img src=x onerror="window.__pwned=1">';
export const HOSTILE_DESCRIPTION =
  '<script>window.__pwned=2</script><b onmouseover="x()">about</b>';

class Key {
  readonly #sk = generateSecretKey();
  readonly pubkey = getPublicKey(this.#sk);

  sign(e: {
    readonly kind: number;
    readonly created_at: number;
    readonly tags: readonly (readonly string[])[];
    readonly content: string;
  }): NostrEvent {
    const signed = finalizeEvent(
      {
        kind: e.kind,
        created_at: e.created_at,
        tags: e.tags.map((t) => [...t]),
        content: e.content,
      },
      this.#sk,
    );
    return JSON.parse(JSON.stringify(signed)) as NostrEvent;
  }
}

export interface World {
  readonly relayUrl: string;
  /** The video's NFX address. */
  readonly addr: string;
  close(): Promise<void>;
}

export async function startWorld(bootstrap: readonly DhtNode[]): Promise<World> {
  const seederKey = new Key();
  const creator = new Key();
  const videoId = `proof-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 24)}`;
  const pkg = makeVp9Package(`${NS}:${videoId}`);

  // Not firewalled, as a public seeder is: the worker tells no peer its local addresses
  // (`net/no-local-addresses.ts`), so on one host it meets only a node it can reach directly.
  const dht = new DHT({ bootstrap: [...bootstrap], firewalled: false });
  await dht.fullyBootstrapped();
  const keyPair = DHT.keyPair();
  const source: NfxFileSource = {
    hasVideo: (v) => v.toString() === pkg.video,
    file: (v, sha) => {
      const data = v.toString() === pkg.video ? pkg.files.get(sha) : undefined;
      if (data === undefined) return undefined;
      return {
        size: data.byteLength,
        read: (offset, length) => Promise.resolve(data.subarray(offset, offset + length)),
      };
    },
  };
  const listener = await listenNfx(dht, { keyPair, source });
  const endpoint = hyperdhtEndpoint(keyPair, seederKey.pubkey, NS);
  const addr = `38504:${creator.pubkey}:${NS}:${videoId}`;

  const relay = await TestRelay.start({
    beaconEveryMs: 2_000,
    beacon: () => {
      const at = Math.floor(Date.now() / 1000);
      const tags = beaconTags(addr, at, 120);
      if (!tags.ok) throw new Error(tags.error.reason);
      return seederKey.sign({
        kind: 20464,
        created_at: at,
        tags: tags.value,
        content: JSON.stringify({
          v: 1,
          video: pkg.video,
          endpoints: [{ t: 'hyperdht', peer: endpoint.peer, bind: endpoint.bind }],
          chunks: 'all',
          price_hint: 0,
          free: true,
        }),
      });
    },
  });
  const at = Math.floor(Date.now() / 1000) - 3600;
  relay.store(
    creator.sign({
      kind: 38504,
      created_at: at,
      content: HOSTILE_DESCRIPTION,
      tags: [
        ['d', `${NS}:${videoId}`],
        ['n', NS],
        ['title', HOSTILE_TITLE],
        ['published_at', String(at)],
        ['license', 'open'],
        ['root', pkg.root],
        ['segs', String(pkg.segs)],
        ['duration', String(Math.round(pkg.durationSec))],
        ['t', 'space'],
      ],
    }),
  );
  return {
    relayUrl: relay.url,
    addr,
    close: async () => {
      await relay.close().catch(() => undefined);
      await listener.close().catch(() => undefined);
      await dht.destroy().catch(() => undefined);
    },
  };
}
