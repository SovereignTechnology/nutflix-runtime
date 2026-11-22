/**
 * The renderer's first-run settings. Adapted from nutflix-pear's `packages/app-web/src/settings/
 * defaults.ts` and the desktop app's `DEFAULT_SETTINGS` / `DEFAULT_NFX` (`app-desktop/src/host/
 * settings/settings.ts`), at the submodule's pinned commit, except the general relays below.
 *
 * - **Relays:** the network's scoped relay `wss://relay.nutflix.xyz` first (manifests and beacons,
 *   NFX-04), then `relay.primal.net` and `relay.ditto.pub` (which answers NIP-50 search). The
 *   maintainer took `relay.damus.io` and `nos.lol` out of the client defaults on 2026-11-18: the
 *   first refuses this project's address and the second has rate-limited it. nutflix-pear makes
 *   the same change in its PR #120.
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
