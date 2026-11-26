/**
 * The update gate's trust root: which key signs a release notice, which relays carry it, and which
 * `pear://` link the app follows. It is BAKED IN at package time (`packaging/update-root.ts` makes
 * it, `packaging/stage.ts` compiles it into the updater's bundle as one constant). Nothing at run
 * time can change it: no environment variable, switch, file in user data or RPC is read for any
 * field here.
 *
 * Two channels, and the parser keeps them apart:
 *   - `release`: `wss://` relays, the public DHT (no bootstrap field). `upgrade` stays `null`, and
 *     the app starts no updater at all, until a real upgrade link exists.
 *   - `test`: a throwaway key, relays and DHT on 127.0.0.1 only. Only the package step's
 *     `test-build` command can make one, and it refuses the production key. Its `dht` may also be
 *     `null`, HyperDHT's public bootstrap, as a release root's is: the real-host proof
 *     (`scripts/realhost/`), whose installed app must reach a seeder on another network. Its relays
 *     stay on 127.0.0.1 either way; the proof carries them to that network itself.
 *   - `launch`: a throwaway key and a relay on 127.0.0.1, and NO link, so no updater runs. It is
 *     what CI launches once the release build carries a real link (a build with a link is never
 *     launched on a runner). `test-build` makes it too.
 *
 * A `test` root may also carry `play`: a relay on 127.0.0.1 and one NFX address, the install job's
 * packaged-playback proof (`src/main/play-proof.ts`). Main holds the same baked root as the updater
 * (`packaging/stage.ts`), and with it the data worker joins the root's private DHT and the window
 * opens and plays that video. A `release` or `launch` root refuses the field, as it refuses a DHT,
 * so no build that can ship or that CI launches in a release's place carries it.
 *
 * Pure and runtime-neutral: it runs in Bare, in Node and in the tests.
 */

export const NOTICE_KIND = 30071;
export const NOTICE_D = 'nutflix-runtime';

export interface TrustRoot {
  readonly v: 1;
  readonly channel: 'release' | 'test' | 'launch';
  /** The key that signs release notices, as 64 lowercase hex. */
  readonly pubkey: string;
  readonly relays: readonly string[];
  /** The `pear://<key>` link the app follows; `null` means no updater runs. */
  readonly upgrade: string | null;
  /**
   * `test` only: the private DHT's `127.0.0.1:<port>` nodes, or `null` for the public one (as on
   * every other channel). No other node is ever named.
   */
  readonly dht: readonly string[] | null;
  /** `test` only: the updater's delay for an append after the boot window, ms. */
  readonly delayMs: number | null;
  /** `test` only, and optional: what the packaged-playback proof opens. Absent everywhere else. */
  readonly play?: PlayProof;
}

/**
 * The install job's playback proof, baked into a TEST build: the catalog relays the window uses and
 * the one video it opens and plays (`src/main/play-proof.ts`). Every address is on loopback.
 */
export interface PlayProof {
  /** `ws://127.0.0.1:<port>`: where the manifest and the seeders' beacons are. */
  readonly relays: readonly string[];
  /** The NFX address to open, `38504:<creator>:nfx:testnet:1:<video id>`. */
  readonly video: string;
}

export const MAX_RELAYS = 8;
const HEX64 = /^[0-9a-f]{64}$/;
const LINK = /^pear:\/\/[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;
const RELEASE_RELAY = /^wss:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?$/;
const LOOPBACK_RELAY = /^ws:\/\/127\.0\.0\.1:[0-9]{2,5}$/;
const LOOPBACK_NODE = /^127\.0\.0\.1:[0-9]{2,5}$/;
const KEYS = ['channel', 'delayMs', 'dht', 'pubkey', 'relays', 'upgrade', 'v'];
/** The one optional field: `play`, on a `test` root only. */
const OPTIONAL_KEYS = ['play'];
const PLAY_KEYS = ['relays', 'video'];
/** An NFX address on the network a test build plays (NFX-02 §2), with a short video id. */
const PLAY_VIDEO = /^38504:[0-9a-f]{64}:nfx:testnet:1:[a-z0-9][a-z0-9-]{0,63}$/;

export class TrustRootError extends Error {
  override readonly name = 'TrustRootError' as const;
}

const refuse = (why: string): never => {
  throw new TrustRootError(`trust root: ${why}`);
};

function stringList(x: unknown, what: string, max: number): readonly string[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > max)
    return refuse(`${what} must list 1 to ${String(max)} entries`);
  const out: string[] = [];
  for (const v of x as unknown[]) {
    if (typeof v !== 'string') return refuse(`${what} must be strings`);
    out.push(v);
  }
  if (new Set(out).size !== out.length) return refuse(`${what} repeats an entry`);
  return out;
}

/** `x` as a trust root, or it throws. Every field is checked; an unknown field is refused. */
export function parseTrustRoot(x: unknown): TrustRoot {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return refuse('not an object');
  const r = x as Record<string, unknown>;
  const keys = Object.keys(r)
    .filter((k) => !OPTIONAL_KEYS.includes(k))
    .sort();
  if (keys.length !== KEYS.length || keys.some((k, i) => k !== KEYS[i]))
    return refuse('wrong fields');
  const hasPlay = Object.prototype.hasOwnProperty.call(r, 'play');
  if (r['v'] !== 1) return refuse('unknown version');
  const channel = r['channel'];
  if (channel !== 'release' && channel !== 'test' && channel !== 'launch')
    return refuse('unknown channel');
  const pubkey = r['pubkey'];
  if (typeof pubkey !== 'string' || !HEX64.test(pubkey))
    return refuse('the key must be 64 lowercase hex');
  const upgrade = r['upgrade'];
  if (upgrade !== null && (typeof upgrade !== 'string' || !LINK.test(upgrade)))
    return refuse('the upgrade link must be pear://<z32 key>, unversioned');
  const relays = stringList(r['relays'], 'relays', MAX_RELAYS);
  const relayShape = channel === 'release' ? RELEASE_RELAY : LOOPBACK_RELAY;
  if (relays.some((u) => !relayShape.test(u)))
    return refuse(
      channel === 'release'
        ? 'a release relay must be a bare wss:// origin'
        : 'a test relay must be ws://127.0.0.1:<port>',
    );
  let dht: readonly string[] | null = null;
  let delayMs: number | null = null;
  let play: PlayProof | undefined;
  if (channel === 'release') {
    if (r['dht'] !== null) return refuse('a release build names no DHT bootstrap');
    if (r['delayMs'] !== null) return refuse('a release build keeps the default delay');
    if (hasPlay) return refuse('a release build opens no video by itself');
  } else if (channel === 'launch') {
    if (upgrade !== null) return refuse('a launch build has no upgrade link');
    if (r['dht'] !== null) return refuse('a launch build names no DHT bootstrap');
    if (r['delayMs'] !== null) return refuse('a launch build has no updater delay');
    if (hasPlay) return refuse('a launch build opens no video by itself');
  } else {
    // `null`: HyperDHT's public bootstrap (the real-host proof). Any node it names is on loopback.
    if (r['dht'] !== null) {
      dht = stringList(r['dht'], 'dht', 16);
      if (dht.some((n) => !LOOPBACK_NODE.test(n)))
        return refuse('a test DHT node must be 127.0.0.1:<port>');
    }
    const d = r['delayMs'];
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 60_000)
      return refuse('a test delay must be 0 to 60000 ms');
    delayMs = d;
    if (upgrade === null) return refuse('a test build needs an upgrade link');
    if (hasPlay) play = parsePlay(r['play']);
  }
  return Object.freeze({
    v: 1 as const,
    channel,
    pubkey,
    relays: Object.freeze([...relays]),
    upgrade: upgrade,
    dht: dht === null ? null : Object.freeze([...dht]),
    delayMs,
    ...(play === undefined ? {} : { play }),
  });
}

/** A test root's `play`: exactly its two fields, every relay on loopback, one NFX address. */
function parsePlay(x: unknown): PlayProof {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return refuse('play: not an object');
  const p = x as Record<string, unknown>;
  const keys = Object.keys(p).sort();
  if (keys.length !== PLAY_KEYS.length || keys.some((k, i) => k !== PLAY_KEYS[i]))
    return refuse('play: wrong fields');
  const relays = stringList(p['relays'], 'play relays', MAX_RELAYS);
  if (relays.some((u) => !LOOPBACK_RELAY.test(u)))
    return refuse('a play relay must be ws://127.0.0.1:<port>');
  const video = p['video'];
  if (typeof video !== 'string' || !PLAY_VIDEO.test(video))
    return refuse('play: the video must be an NFX address on nfx:testnet:1');
  return Object.freeze({ relays: Object.freeze([...relays]), video });
}

/** The link's key: the z32 text after `pear://`. */
export function linkKey(link: string): string {
  if (!LINK.test(link)) return refuse('not an unversioned pear:// link');
  return link.slice('pear://'.length);
}

// ---- the baked constant ----------------------------------------------------------------------

/**
 * How the root sits in the bundle: one string of this prefix and hex. Hex so that the bundler
 * prints it verbatim, and the package step can find it again and prove which root a build carries.
 */
export const BAKED_PREFIX = 'NUTFLIX_UPDATE_ROOT:';
export const BAKED_PATTERN = /NUTFLIX_UPDATE_ROOT:[0-9a-f]+/g;

export function encodeBakedRoot(root: TrustRoot): string {
  const text = JSON.stringify(parseTrustRoot(root));
  let hex = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c >= 0x80) return refuse('a root is ASCII');
    hex += c.toString(16).padStart(2, '0');
  }
  return `${BAKED_PREFIX}${hex}`;
}

export function decodeBakedRoot(baked: string): TrustRoot {
  if (!baked.startsWith(BAKED_PREFIX)) return refuse('not a baked root');
  const hex = baked.slice(BAKED_PREFIX.length);
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex))
    return refuse('not a baked root');
  let text = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = Number.parseInt(hex.slice(i, i + 2), 16);
    if (c >= 0x80) return refuse('a root is ASCII');
    text += String.fromCharCode(c);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('not JSON');
  }
  return parseTrustRoot(parsed);
}
