/**
 * Whether a play uses the WebRTC mesh, from the settings alone (ADR 0001 decision 4; contracts
 * v17 and v18). `NfxSettings.webrtc` absent means on. `meshRelays` and `stunServers` absent mean
 * the network's defaults, and an empty list means none, which leaves WebRTC off: with no relay
 * nobody can be met, and with no STUN server a peer behind a NAT has nothing to offer once the
 * remote-candidate filter has dropped LAN and mDNS candidates.
 */
import type { NfxSettings } from '@sovit/core';

import { DEFAULT_MESH_RELAYS, DEFAULT_STUN_SERVERS } from './defaults.js';

export type WebRtcOff = 'switched-off' | 'no-relays' | 'no-stun';

/** Why the settings leave WebRTC off, or `null` when they do not. */
export function webrtcOff(nfx: NfxSettings | undefined): WebRtcOff | null {
  if (nfx?.webrtc === false) return 'switched-off';
  if ((nfx?.meshRelays ?? DEFAULT_MESH_RELAYS).length === 0) return 'no-relays';
  if ((nfx?.stunServers ?? DEFAULT_STUN_SERVERS).length === 0) return 'no-stun';
  return null;
}

export interface WebRtcPlan {
  readonly meshRelays: readonly string[];
  /** One `stun:` URL per server, as the library's `iceServers` takes them. */
  readonly iceServers: readonly { readonly urls: readonly string[] }[];
}

/** What a play signals through and asks for its public address, or `null` when WebRTC is off. */
export function webrtcPlan(nfx: NfxSettings | undefined): WebRtcPlan | null {
  if (webrtcOff(nfx) !== null) return null;
  return {
    meshRelays: [...(nfx?.meshRelays ?? DEFAULT_MESH_RELAYS)],
    iceServers: (nfx?.stunServers ?? DEFAULT_STUN_SERVERS).map((s) => ({ urls: [`stun:${s}`] })),
  };
}

const OFF_WHY: Readonly<Record<WebRtcOff, string>> = Object.freeze({
  'switched-off': 'WebRTC is off because you switched it off',
  'no-relays': 'WebRTC is off because no signaling relay is set',
  'no-stun': 'WebRTC is off because no STUN server is set',
});

/**
 * The line Settings shows, or `null` when WebRTC is working. The runtime's reason comes first:
 * with the player unavailable, a setting cannot turn it on. `beaconOrigins` (default on): whether
 * a video may play from the `https` origins its beacons name, through the web player with no mesh
 * (`RendererOptions.beaconOrigins`).
 */
export function webrtcStatusText(
  probeReason: string | null,
  nfx: NfxSettings | undefined,
  beaconOrigins = true,
): string | null {
  if (probeReason !== null) return `WebRTC is off. ${probeReason}`;
  const off = webrtcOff(nfx);
  if (off === null) return null;
  return beaconOrigins
    ? `${OFF_WHY[off]}: no peer connections. Videos play over HyperDHT, or from the HTTPS hosts their seeders name.`
    : `${OFF_WHY[off]}: videos play over HyperDHT alone.`;
}

/**
 * What Settings says beside the WebRTC switch while the web player may fetch from the `https`
 * hosts that beacons name, or `null` when it may not (no web player, or a window that does not).
 */
export function beaconOriginsText(player: boolean, beaconOrigins = true): string | null {
  return player && beaconOrigins
    ? 'A video that its seeders serve over HTTPS (as nfxd does) plays from the web hosts their ' +
        'announcements name, with WebRTC on or off. Those hosts see your IP address and which ' +
        'videos you watch, as any seeder does. Every byte is still checked against the video’s ' +
        'signed hash list.'
    : null;
}
