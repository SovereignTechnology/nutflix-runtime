/**
 * What the proofs read from a page, installed before any of its scripts. It only observes:
 *
 *   - every SDP handed to `setRemoteDescription`, so that the candidates that reach the ICE agent
 *     can be checked after the player's filter;
 *   - each connection's selected candidate pair, with its counters, every second;
 *   - the bytes received on data channels;
 *   - the sha256 of everything appended to a `SourceBuffer`: the bytes that actually played.
 */
export const OBSERVER_SCRIPT = `(() => {
  const m = { remoteSdp: [], pairs: {}, dcIn: 0, dcOut: 0, appended: [], pending: 0, pcs: 0 };
  globalThis.__observed = m;
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  if (typeof SourceBuffer === 'function') {
    const append = SourceBuffer.prototype.appendBuffer;
    SourceBuffer.prototype.appendBuffer = function (data) {
      const view = data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      const copy = view.slice();
      m.pending += 1;
      crypto.subtle.digest('SHA-256', copy).then((h) => {
        m.appended.push({ sha256: hex(h), bytes: copy.byteLength });
        m.pending -= 1;
      });
      return append.call(this, data);
    };
  }
  const Native = globalThis.RTCPeerConnection;
  if (typeof Native !== 'function') return;
  const size = (x) => (typeof x === 'string' ? x.length : (x.byteLength ?? x.size ?? 0));
  const watch = (ch) => {
    ch.addEventListener('message', (e) => { m.dcIn += size(e.data); });
    const send = ch.send;
    ch.send = function (x) { m.dcOut += size(x); return send.call(this, x); };
  };
  const setRemote = Native.prototype.setRemoteDescription;
  Native.prototype.setRemoteDescription = function (d, ...rest) {
    if (d && typeof d.sdp === 'string') m.remoteSdp.push(d.sdp);
    return setRemote.call(this, d, ...rest);
  };
  const createChannel = Native.prototype.createDataChannel;
  Native.prototype.createDataChannel = function (...args) {
    const ch = createChannel.apply(this, args);
    watch(ch);
    return ch;
  };
  const sample = async (pc, id) => {
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((s) => {
        if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
      });
      if (pair) {
        const local = stats.get(pair.localCandidateId);
        const remote = stats.get(pair.remoteCandidateId);
        m.pairs[id] = {
          state: pair.state,
          local: local && { address: local.address, type: local.candidateType, protocol: local.protocol },
          remote: remote && { address: remote.address, type: remote.candidateType, protocol: remote.protocol },
          bytesReceived: pair.bytesReceived,
          bytesSent: pair.bytesSent,
        };
      }
    } catch {}
  };
  globalThis.RTCPeerConnection = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget);
      const id = String(m.pcs++);
      pc.addEventListener('datachannel', (e) => watch(e.channel));
      const t = setInterval(() => {
        if (pc.connectionState === 'closed') clearInterval(t);
        else void sample(pc, id);
      }, 1000);
      return pc;
    },
  });
})();`;

export interface ObservedPair {
  readonly state: string;
  readonly local?: {
    readonly address?: string;
    readonly type?: string;
    readonly protocol?: string;
  };
  readonly remote?: {
    readonly address?: string;
    readonly type?: string;
    readonly protocol?: string;
  };
  readonly bytesReceived: number;
  readonly bytesSent: number;
}

export interface Observed {
  readonly remoteSdp: readonly string[];
  readonly pairs: Readonly<Record<string, ObservedPair>>;
  readonly dcIn: number;
  readonly dcOut: number;
  readonly appended: readonly { readonly sha256: string; readonly bytes: number }[];
  readonly pending: number;
  readonly pcs: number;
}

/** The address of every `a=candidate` line of `sdp`. */
export function candidateAddresses(sdp: string): string[] {
  const out: string[] = [];
  for (const line of sdp.split(/\r\n|\n|\r/)) {
    if (!line.startsWith('a=candidate:')) continue;
    out.push(line.split(' ')[4] ?? '');
  }
  return out;
}
