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

const OFF_TEXT: Readonly<Record<WebRtcOff, string>> = Object.freeze({
  'switched-off': 'WebRTC is off because you switched it off: videos play over HyperDHT alone.',
  'no-relays': 'WebRTC is off because no signaling relay is set: videos play over HyperDHT alone.',
  'no-stun': 'WebRTC is off because no STUN server is set: videos play over HyperDHT alone.',
});

/**
 * The line Settings shows, or `null` when WebRTC is working. The runtime's reason comes first:
 * with the player unavailable, a setting cannot turn it on.
 */
export function webrtcStatusText(
  probeReason: string | null,
  nfx: NfxSettings | undefined,
): string | null {
  if (probeReason !== null) return `WebRTC is off. ${probeReason}`;
  const off = webrtcOff(nfx);
  return off === null ? null : OFF_TEXT[off];
}
