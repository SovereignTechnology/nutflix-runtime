/**
 * What this renderer's shell offers: the screens that list and play free NFX videos, and the
 * settings that matter to them. Modelled on nutflix-pear's `packages/app-web/src/shell/offer.ts`
 * (the submodule's pinned commit). Everything that needs a wallet, a signer, a seeder or Studio is
 * left out, so nothing a viewer can reach calls a method the adapter rejects:
 *
 * - **Sidebar:** Home and Settings. Shorts, Subscriptions, Library, Studio and Wallet are not
 *   offered, and a route into one shows Home. Watch, Channel and Search are always offered.
 * - **Home:** the Network and Tags feeds; Trending and Subscriptions are NIP-71 or signed-in only.
 * - **Settings:** Appearance (without "Load images from any website": only signed images are
 *   shown), Playback, Relays and NFX (no switch, since NFX is always on; no iroh relays; the
 *   WebRTC switch with its IP-address disclosure, and the signaling relays).
 * - **No sign-in** in the header: this version signs nothing (ADR 0001 decision 8 comes later).
 * - **No source link** yet: the AGPL §13 offer belongs to the shell that serves the renderer.
 */
import type { ShellOffer } from '@sovit/ui';

export const RUNTIME_OFFER: ShellOffer = Object.freeze({
  sections: Object.freeze(['home', 'settings'] as const),
  homeTabs: Object.freeze(['network', 'tags'] as const),
  settingsSections: Object.freeze(['appearance', 'playback', 'relays', 'nfx'] as const),
  nfxParts: Object.freeze({
    toggle: false,
    scopedRelays: true,
    irohRelays: false,
    trackers: false,
    meshNotice: false,
    webrtc: true,
    meshRelays: true,
  }),
  appearanceParts: Object.freeze({ remoteImages: false }),
  signIn: false,
});
