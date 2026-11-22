/**
 * The renderer's first-run settings. Adapted from nutflix-pear's `packages/app-web/src/settings/
 * defaults.ts` and the desktop app's `DEFAULT_SETTINGS` / `DEFAULT_NFX` (`app-desktop/src/host/
 * settings/settings.ts`), at the submodule's pinned commit; the values are those two apps' own, so
 * a viewer sees the same catalogue in each.
 *
 * - **Relays:** the network's scoped relay `wss://relay.nutflix.xyz` first (manifests and beacons,
 *   NFX-04), then the four public read relays of ADR 0009 with its 2026-11-07 amendment
 *   (`relay.ditto.pub` answers NIP-50 search).
 * - **NFX, always on**, on `nfx:testnet:1`. No iroh relay (no iroh here), and no mesh or STUN
 *   setting yet: the WebRTC player is slice B.
 * - **No wallet, no seeding, no unsigned images:** those fields are fixed, never stored.
 *
 * Every value here is a public name.
 */
import type { NfxNetwork, NfxSettings, RelayUrl, Settings } from '@sovit/core';

export const NFX_NETWORK: NfxNetwork = 'nfx:testnet:1';

/** The network's scoped relay (manifests and beacons), the first relay the app speaks to. */
export const SCOPED_RELAY = 'wss://relay.nutflix.xyz' as RelayUrl;

export const DEFAULT_NFX: NfxSettings = Object.freeze({
  enabled: true,
  network: NFX_NETWORK,
  scopedRelays: Object.freeze([SCOPED_RELAY]),
});

const relay = (url: string): Settings['relays'][number] =>
  Object.freeze({ url: url as RelayUrl, read: true, write: true });

export const DEFAULT_SETTINGS: Settings = Object.freeze({
  relays: Object.freeze([
    relay('wss://relay.damus.io'),
    relay('wss://nos.lol'),
    relay('wss://relay.primal.net'),
    relay('wss://relay.ditto.pub'),
  ]),
  // Fixed in this slice: no wallet, no seeding, and only images whose sha256 the publisher signed.
  defaultMints: Object.freeze([]),
  seeding: Object.freeze({ enabled: false, diskCapBytes: 0, serveImages: false }),
  prefetchSeconds: 30,
  hoverPreview: true,
  loadRemoteImages: false,
  theme: 'system' as const,
  nfx: DEFAULT_NFX,
});
