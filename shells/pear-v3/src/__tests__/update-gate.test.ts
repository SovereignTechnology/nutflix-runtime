/**
 * The update gate, refusal by refusal, with real Schnorr signatures (`nostr-tools`) and fakes for
 * the updater, the relays and the file system. What the real updater does on five platforms is the
 * install job's proof (`scripts/pear-ci/update-proof.ts`).
 */
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, readdir, readlink } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAIN_WINDOW_POLICY, RpcGate } from '../main/rpc-gate.ts';
import { installedApp, startUpdater } from '../main/update-proc.ts';
import { UpdateGate, artifactName, verlinkOf, type GateDeps } from '../update/gate.ts';
import {
  MAX_TREE_ENTRIES,
  artifactDigest,
  type HashFs,
  type Sha256Factory,
} from '../update/hash.ts';
import {
  MAX_ARTIFACTS,
  MAX_CONTENT_CHARS,
  MAX_FUTURE_S,
  MAX_NOTICE_TAGS,
  MAX_TAG_CHARS,
  MAX_TAG_ITEMS,
  decide,
  isNewer,
  newestNotice,
  parseFloor,
  readNotice,
  type Candidate,
  type Floor,
  type Notice,
} from '../update/notice.ts';
import {
  MAX_RELAY_BYTES,
  MAX_RELAY_EVENTS,
  MAX_RELAY_MESSAGE_BYTES,
  fetchNotices,
  type RelayConnect,
  type RelaySocket,
} from '../update/relays.ts';
import {
  BAKED_PREFIX,
  NOTICE_D,
  NOTICE_KIND,
  TrustRootError,
  decodeBakedRoot,
  encodeBakedRoot,
  linkKey,
  parseTrustRoot,
  type TrustRoot,
} from '../update/root.ts';
import {
  parseUpdateStart,
  parseUpdateStatus,
  type UpdateStart,
  type UpdateStatus,
} from '../update/status.ts';

const KEY = 'y'.repeat(52);
const LINK = `pear://${KEY}`;
const SK = generateSecretKey();
const PK = getPublicKey(SK);
const OTHER = generateSecretKey();
const NOW = 1_800_000_000;
const SHA = 'ab'.repeat(32);
const VERLINK = `pear://0.7.${KEY}`;
const ARTIFACT = 'Nutflix-linux-x64.AppImage';

const testRoot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  channel: 'test',
  pubkey: PK,
  relays: ['ws://127.0.0.1:7777'],
  upgrade: LINK,
  dht: ['127.0.0.1:49737'],
  delayMs: 0,
  ...over,
});
const releaseShape = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  channel: 'release',
  pubkey: PK,
  relays: ['wss://relay.example.org'],
  upgrade: null,
  dht: null,
  delayMs: null,
  ...over,
});
const ROOT: TrustRoot = parseTrustRoot(testRoot());
const PLAY = {
  relays: ['ws://127.0.0.1:7778'],
  video: `38504:${'cd'.repeat(32)}:nfx:testnet:1:packaged-playback-1`,
};

interface Fields {
  createdAt?: number;
  version?: string;
  verlink?: string;
  sha256?: string;
  tags?: string[][];
  extraTags?: string[][];
  content?: string;
  kind?: number;
}

const template = (
  f: Fields = {},
): {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
} => ({
  kind: f.kind ?? NOTICE_KIND,
  created_at: f.createdAt ?? NOW,
  content: f.content ?? `${f.sha256 ?? SHA}  ${ARTIFACT}\n`,
  tags: f.tags ?? [
    ['d', NOTICE_D],
    ['version', f.version ?? '1.0.2'],
    ['verlink', f.verlink ?? VERLINK],
    ['artifact', ARTIFACT, f.sha256 ?? SHA, '1234'],
    ...(f.extraTags ?? []),
  ],
});
const signed = (f: Fields = {}, sk: Uint8Array = SK): Record<string, unknown> => ({
  ...finalizeEvent(template(f), sk),
});
const CANDIDATE: Candidate = {
  verlink: VERLINK,
  version: '1.0.2',
  artifact: ARTIFACT,
  sha256: SHA,
};

const refusal = (raw: unknown): unknown => readNotice(raw, ROOT, NOW).refused;

// ---- the trust root --------------------------------------------------------------------------

describe('the trust root', () => {
  it('takes a release root and a test root', () => {
    expect(parseTrustRoot(releaseShape()).channel).toBe('release');
    expect(parseTrustRoot(testRoot()).dht).toEqual(['127.0.0.1:49737']);
  });

  it.each([
    ['not an object', 'x'],
    ['an array', []],
    ['an extra field', testRoot({ extra: 1 })],
    ['a missing field', (({ dht: _d, ...r }) => r)(testRoot())],
    ['another version', testRoot({ v: 2 })],
    ['another channel', testRoot({ channel: 'beta' })],
    ['a short key', testRoot({ pubkey: 'ab' })],
    ['an uppercase key', testRoot({ pubkey: PK.toUpperCase() })],
    ['a versioned upgrade link', testRoot({ upgrade: `pear://0.7.${KEY}` })],
    ['no relays', testRoot({ relays: [] })],
    ['a repeated relay', testRoot({ relays: ['ws://127.0.0.1:7777', 'ws://127.0.0.1:7777'] })],
    [
      'too many relays',
      testRoot({
        relays: Array.from({ length: 9 }, (_, i) => `ws://127.0.0.1:${String(7000 + i)}`),
      }),
    ],
    ['a public relay in a test root', testRoot({ relays: ['wss://relay.example.org'] })],
    ['a LAN relay in a test root', testRoot({ relays: ['ws://192.168.1.2:7777'] })],
    ['a public DHT node in a test root', testRoot({ dht: ['88.99.3.86:49737'] })],
    ['a test root with no link', testRoot({ upgrade: null })],
    ['a test root with a huge delay', testRoot({ delayMs: 60_001 })],
    ['plain ws in a release root', releaseShape({ relays: ['ws://relay.example.org'] })],
    ['a relay with a path', releaseShape({ relays: ['wss://relay.example.org/x'] })],
    ['a relay with user-info', releaseShape({ relays: ['wss://u@relay.example.org'] })],
    ['a DHT in a release root', releaseShape({ dht: ['127.0.0.1:49737'] })],
    ['a delay in a release root', releaseShape({ delayMs: 0 })],
    ['a playback proof in a release root', releaseShape({ play: PLAY })],
    ['a null playback proof in a release root', releaseShape({ play: null })],
    [
      'a playback proof in a launch root',
      releaseShape({ channel: 'launch', relays: ['ws://127.0.0.1:7777'], play: PLAY }),
    ],
    ['a playback proof that is not an object', testRoot({ play: 'x' })],
    ['a playback proof with an extra field', testRoot({ play: { ...PLAY, seconds: 5 } })],
    ['a playback proof with no relay', testRoot({ play: { ...PLAY, relays: [] } })],
    [
      'a playback proof with a public relay',
      testRoot({ play: { ...PLAY, relays: ['wss://relay.example.org'] } }),
    ],
    [
      'a playback proof on another network',
      testRoot({ play: { ...PLAY, video: PLAY.video.replace('testnet', 'mainnet') } }),
    ],
    [
      'a playback proof with a link in place of a video',
      testRoot({ play: { ...PLAY, video: 'https://example.org/x' } }),
    ],
  ])('refuses %s', (_name, x) => {
    expect(() => parseTrustRoot(x)).toThrow(TrustRootError);
  });

  it('takes a test root on the public DHT, its relays and playback proof still on loopback', () => {
    const r = parseTrustRoot(testRoot({ dht: null, play: PLAY }));
    expect(r.channel).toBe('test');
    expect(r.dht).toBeNull();
    expect(r.play).toEqual(PLAY);
    expect(decodeBakedRoot(encodeBakedRoot(r))).toEqual(r);
    // Only `null` means the public network: a public node, or no node at all, is still refused.
    expect(() => parseTrustRoot(testRoot({ dht: null, relays: ['wss://relay.example.org'] }))).toThrow(
      /a test relay must be ws:\/\/127\.0\.0\.1/,
    );
    expect(() =>
      parseTrustRoot(testRoot({ dht: null, play: { ...PLAY, relays: ['wss://relay.example.org'] } })),
    ).toThrow(/a play relay must be ws:\/\/127\.0\.0\.1/);
    expect(() => parseTrustRoot(testRoot({ dht: [] }))).toThrow(TrustRootError);
  });

  it('takes a playback proof in a test root only, and keeps it through the baked constant', () => {
    const r = parseTrustRoot(testRoot({ play: PLAY }));
    expect(r.play).toEqual(PLAY);
    expect(decodeBakedRoot(encodeBakedRoot(r))).toEqual(r);
    // Absent, it is absent: a root without one bakes to the same bytes as before.
    expect('play' in parseTrustRoot(testRoot())).toBe(false);
    expect(() => parseTrustRoot(releaseShape({ play: PLAY }))).toThrow(
      /a release build opens no video by itself/,
    );
  });

  it('round-trips through the baked constant, as hex only', () => {
    const baked = encodeBakedRoot(ROOT);
    expect(baked.startsWith(BAKED_PREFIX)).toBe(true);
    expect(baked.slice(BAKED_PREFIX.length)).toMatch(/^[0-9a-f]+$/);
    expect(decodeBakedRoot(baked)).toEqual(ROOT);
  });

  it.each([
    ['no prefix', 'abcd'],
    ['odd hex', `${BAKED_PREFIX}abc`],
    ['empty', BAKED_PREFIX],
    ['not hex', `${BAKED_PREFIX}zz`],
    ['not JSON', `${BAKED_PREFIX}7b7b`],
    ['not ASCII', `${BAKED_PREFIX}ff`],
    ['a root that does not parse', `${BAKED_PREFIX}7b7d`],
  ])('refuses a baked root that is %s', (_n, b) => {
    expect(() => decodeBakedRoot(b)).toThrow(TrustRootError);
  });

  it('reads the key out of a link, and nothing else', () => {
    expect(linkKey(LINK)).toBe(KEY);
    expect(() => linkKey(`pear://0.7.${KEY}`)).toThrow(TrustRootError);
  });
});

// ---- one notice ------------------------------------------------------------------------------

describe('reading a notice', () => {
  it('takes a good one', () => {
    const r = readNotice(signed(), ROOT, NOW);
    expect(r.notice?.verlink).toBe(VERLINK);
    expect(r.notice?.artifacts.get(ARTIFACT)).toEqual({ sha256: SHA, bytes: 1234 });
  });

  it.each([null, 'x', [], 1])('refuses %j as a shape', (x) => {
    expect(refusal(x)).toBe('shape');
  });

  it.each([
    ['id', { id: 'ab' }],
    ['pubkey', { pubkey: 'ab' }],
    ['sig', { sig: 'ab' }],
    ['created_at', { created_at: 1.5 }],
    ['negative created_at', { created_at: -1 }],
    ['kind', { kind: '30071' }],
    ['content', { content: 1 }],
    ['tags', { tags: 'x' }],
    ['an empty tag', { tags: [[]] }],
    ['a tag that is not strings', { tags: [['d', 1]] }],
  ])('refuses a bad %s', (_n, patch) => {
    expect(refusal({ ...signed(), ...patch })).toBe('shape');
  });

  it('bounds the content, the tag count, and each tag', () => {
    expect(refusal(signed({ content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }))).toBe('size');
    const many = Array.from({ length: MAX_NOTICE_TAGS + 1 }, () => ['t', 'x']);
    expect(refusal(signed({ tags: many }))).toBe('size');
    expect(refusal(signed({ extraTags: [Array<string>(MAX_TAG_ITEMS + 1).fill('x')] }))).toBe(
      'size',
    );
    expect(refusal(signed({ extraTags: [['t', 'x'.repeat(MAX_TAG_CHARS + 1)]] }))).toBe('size');
  });

  it('refuses another kind', () => {
    expect(refusal(signed({ kind: 1 }))).toBe('kind');
  });

  it('refuses another author, however well signed', () => {
    expect(refusal(signed({}, OTHER))).toBe('author');
  });

  it.each([
    ['no d', [['version', '1.0.2']]],
    ['another d', [['d', 'nutflix-desktop']]],
    [
      'two d tags',
      [
        ['d', NOTICE_D],
        ['d', 'nfx'],
      ],
    ],
    ['a d with extra values', [['d', NOTICE_D, 'x']]],
  ])('refuses %s', (_n, tags) => {
    expect(refusal(signed({ tags }))).toBe('d');
  });

  it('refuses one from more than a day ahead, and takes one just inside', () => {
    expect(refusal(signed({ createdAt: NOW + MAX_FUTURE_S + 1 }))).toBe('future');
    expect(refusal(signed({ createdAt: NOW + MAX_FUTURE_S }))).toBeUndefined();
  });

  it('refuses a changed field, a changed id and a signature by another key', () => {
    const good = signed();
    expect(refusal({ ...good, content: 'changed' })).toBe('signature');
    expect(refusal({ ...good, created_at: NOW - 1 })).toBe('signature');
    expect(refusal({ ...good, id: 'cd'.repeat(32) })).toBe('signature');
    // The release key's name and a correct id, signed by someone else.
    const body = { ...template(), pubkey: PK };
    const id = getEventHash(body);
    expect(refusal({ ...body, id, sig: signed({}, OTHER)['sig'] })).toBe('signature');
  });

  it('does not reuse a verdict cached on the object it was given', () => {
    const good = signed();
    expect(refusal(good)).toBeUndefined();
    good['content'] = 'changed after the first check';
    expect(refusal(good)).toBe('signature');
  });

  const base: string[][] = [
    ['d', NOTICE_D],
    ['version', '1.0.2'],
    ['verlink', VERLINK],
    ['artifact', ARTIFACT, SHA, '1234'],
  ];
  const without = (name: string): string[][] => base.filter((t) => t[0] !== name);
  it.each<[string, string[][]]>([
    ['no version', without('version')],
    ['two versions', [...base, ['version', '9.9.9']]],
    ['a pre-release version', [...without('version'), ['version', '1.0.2-rc.1']]],
    ['no verlink', without('verlink')],
    ['two verlinks', [...base, ['verlink', `pear://0.8.${KEY}`]]],
    ['an unversioned verlink', [...without('verlink'), ['verlink', LINK]]],
    ['a verlink of another scheme', [...without('verlink'), ['verlink', `http://0.7.${KEY}`]]],
    ['no artifact', without('artifact')],
    ['a repeated artifact', [...base, ['artifact', ARTIFACT, 'cd'.repeat(32), '1']]],
    ['an artifact with a path', [...without('artifact'), ['artifact', '../x', SHA, '1']]],
    ['a short sha256', [...without('artifact'), ['artifact', ARTIFACT, 'ab', '1']]],
    ['a size that is not a number', [...without('artifact'), ['artifact', ARTIFACT, SHA, 'x']]],
    ['an artifact tag of the wrong length', [...without('artifact'), ['artifact', ARTIFACT, SHA]]],
    [
      'too many artifacts',
      [
        ...without('artifact'),
        ...Array.from({ length: MAX_ARTIFACTS + 1 }, (_, i) => [
          'artifact',
          `a${String(i)}`,
          SHA,
          '1',
        ]),
      ],
    ],
  ])('refuses %s', (_n, tags) => {
    expect(refusal(signed({ tags }))).toBe('fields');
  });
});

// ---- which notice, and what it means ----------------------------------------------------------

describe('the newest notice, and the decision', () => {
  const n = (createdAt: number, id: string): Notice => ({
    id,
    createdAt,
    version: '1.0.0',
    verlink: VERLINK,
    artifacts: new Map(),
  });

  it('takes the highest created_at, and on a tie the lowest id', () => {
    expect(newestNotice([])).toBeNull();
    expect(newestNotice([n(1, 'b'), n(3, 'c'), n(2, 'a')])?.createdAt).toBe(3);
    expect(newestNotice([n(3, 'b'), n(3, 'a'), n(3, 'c')])?.id).toBe('a');
    expect(isNewer(n(2, 'z'), n(1, 'a'))).toBe(true);
    expect(isNewer(n(2, 'a'), n(2, 'b'))).toBe(true);
    expect(isNewer(n(2, 'b'), n(2, 'b'))).toBe(false);
  });

  const run = (
    events: unknown[],
    o: { reached?: number; floor?: Floor | null; candidate?: Candidate } = {},
  ): ReturnType<typeof decide> =>
    decide({
      events,
      reached: o.reached ?? 1,
      root: ROOT,
      nowS: NOW,
      floor: o.floor ?? null,
      candidate: o.candidate ?? CANDIDATE,
    });
  const reason = (d: ReturnType<typeof decide>): unknown =>
    d.kind === 'hold' ? d.reason : 'match';

  it('matches only on link, version and hash together', () => {
    expect(reason(run([signed()]))).toBe('match');
  });

  it('says relay-unreachable when nothing answered, and no-notice when a relay did', () => {
    expect(reason(run([], { reached: 0 }))).toBe('relay-unreachable');
    expect(reason(run([]))).toBe('no-notice');
  });

  it('counts what it refused, and a refused notice is no notice', () => {
    const d = run([signed({}, OTHER), { junk: true }]);
    expect(reason(d)).toBe('no-notice');
    expect(d.refused).toBe(2);
  });

  it.each([
    ['link-mismatch', { verlink: `pear://0.8.${KEY}` }],
    ['version-mismatch', { version: '1.0.3' }],
    ['hash-mismatch', { sha256: 'cd'.repeat(32) }],
  ])('holds on %s', (want, patch) => {
    expect(reason(run([signed(patch)]))).toBe(want);
  });

  it('holds when the notice lists no artifact for this platform', () => {
    expect(
      reason(run([signed()], { candidate: { ...CANDIDATE, artifact: 'Nutflix-win32-x64.msix' } })),
    ).toBe('no-artifact');
  });

  it('judges only the newest: an older notice naming this build does not count', () => {
    const older = signed({ createdAt: NOW - 100 });
    const newer = signed({ createdAt: NOW - 50, verlink: `pear://0.9.${KEY}`, version: '1.0.3' });
    expect(reason(run([older, newer]))).toBe('link-mismatch');
  });

  it('refuses a replay of a notice older than the floor', () => {
    const old = signed({ createdAt: NOW - 100 });
    const floor = { createdAt: NOW - 50, id: 'ef'.repeat(32) };
    expect(reason(run([old], { floor }))).toBe('stale-notice');
  });

  it('takes the very notice at the floor, and a newer one', () => {
    const e = signed({ createdAt: NOW - 50 });
    expect(reason(run([e], { floor: { createdAt: NOW - 50, id: e['id'] as string } }))).toBe(
      'match',
    );
    expect(reason(run([e], { floor: { createdAt: NOW - 60, id: 'ef'.repeat(32) } }))).toBe('match');
  });

  it('reads a floor file strictly', () => {
    expect(parseFloor({ v: 1, createdAt: 5, id: 'ab'.repeat(32) })).toEqual({
      createdAt: 5,
      id: 'ab'.repeat(32),
    });
    for (const bad of [
      null,
      [],
      { v: 2, createdAt: 5, id: 'ab'.repeat(32) },
      { v: 1, createdAt: -1, id: 'ab'.repeat(32) },
      { v: 1, createdAt: 5, id: 'x' },
    ])
      expect(parseFloor(bad)).toBeNull();
  });
});

// ---- the digest ------------------------------------------------------------------------------

const nodeFs: HashFs = {
  lstat: (p) => lstat(p),
  readdir: (p) => readdir(p),
  readlink: (p) => readlink(p),
  read: (p) => createReadStream(p) as AsyncIterable<Uint8Array>,
  join: (a, b) => join(a, b),
};
const nodeSha: Sha256Factory = () => {
  const h = createHash('sha256');
  return {
    update: (b) => {
      h.update(b);
    },
    digestHex: () => h.digest('hex'),
  };
};

describe('the digest a notice names', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'update-hash-'));
    dirs.push(d);
    return d;
  };
  const digest = (p: string): Promise<string> => artifactDigest(nodeFs, nodeSha, p);
  const posix = process.platform !== 'win32';

  it('of a file is its sha256', async () => {
    const f = join(tmp(), 'a');
    writeFileSync(f, 'hello');
    expect(await digest(f)).toBe(createHash('sha256').update('hello').digest('hex'));
  });

  const bundle = (d: string): void => {
    mkdirSync(join(d, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(d, 'Contents', 'Info.plist'), 'plist');
    writeFileSync(join(d, 'Contents', 'MacOS', 'Nutflix'), 'exe');
    if (posix) {
      chmodSync(join(d, 'Contents', 'MacOS', 'Nutflix'), 0o755);
      chmodSync(join(d, 'Contents', 'Info.plist'), 0o644);
      symlinkSync('MacOS/Nutflix', join(d, 'Contents', 'link'));
    }
  };

  it('of a bundle is the same for the same tree', async () => {
    const a = tmp();
    const b = tmp();
    bundle(a);
    bundle(b);
    expect(await digest(a)).toBe(await digest(b));
  });

  it('of a bundle changes with a byte, a file, a mode or a link target', async () => {
    const a = tmp();
    bundle(a);
    const base = await digest(a);
    const changed = async (edit: (d: string) => void): Promise<string> => {
      const d = tmp();
      bundle(d);
      edit(d);
      return digest(d);
    };
    expect(
      await changed((d) => {
        writeFileSync(join(d, 'Contents', 'Info.plist'), 'plisT');
      }),
    ).not.toBe(base);
    expect(
      await changed((d) => {
        writeFileSync(join(d, 'extra'), '');
      }),
    ).not.toBe(base);
    if (posix) {
      expect(
        await changed((d) => {
          chmodSync(join(d, 'Contents', 'MacOS', 'Nutflix'), 0o644);
        }),
      ).not.toBe(base);
      expect(
        await changed((d) => {
          rmSync(join(d, 'Contents', 'link'));
          symlinkSync('MacOS/Other', join(d, 'Contents', 'link'));
        }),
      ).not.toBe(base);
    }
  });

  it('cannot be made to collide by a newline in a link target or a file name', async () => {
    if (!posix) return;
    const a = tmp();
    symlinkSync('t\nzz', join(a, 'k'));
    writeFileSync(join(a, 'y'), 'same');
    const b = tmp();
    symlinkSync('t', join(b, 'k'));
    writeFileSync(join(b, 'zz\ny'), 'same');
    expect(await digest(a)).not.toBe(await digest(b));
  });

  it('refuses a symlink where the artifact should be', async () => {
    if (!posix) return;
    const d = tmp();
    writeFileSync(join(d, 'real'), 'x');
    symlinkSync('real', join(d, 'link'));
    await expect(digest(join(d, 'link'))).rejects.toThrow(/symlink/);
  });

  it('refuses a tree with too many entries', async () => {
    const fake: HashFs = {
      ...nodeFs,
      lstat: (p) =>
        Promise.resolve({
          isFile: () => p !== '/t',
          isDirectory: () => p === '/t',
          isSymbolicLink: () => false,
          mode: 0o644,
        }),
      readdir: () =>
        Promise.resolve(Array.from({ length: MAX_TREE_ENTRIES + 1 }, (_, i) => String(i))),
      // eslint-disable-next-line @typescript-eslint/require-await
      read: async function* () {
        yield new Uint8Array(1);
      },
      join: (a, b) => `${a}/${b}`,
    };
    await expect(artifactDigest(fake, nodeSha, '/t')).rejects.toThrow(/too many/);
  }, 120_000);
});

// ---- the relays -------------------------------------------------------------------------------

class FakeSocket implements RelaySocket {
  sent: string[] = [];
  destroyed = false;
  #onMessage: ((t: string) => void) | null = null;
  #onEnd: (() => void) | null = null;
  constructor(readonly script?: (s: FakeSocket) => void) {}
  onMessage(cb: (t: string) => void): void {
    this.#onMessage = cb;
  }
  onEnd(cb: () => void): void {
    this.#onEnd = cb;
  }
  send(t: string): void {
    this.sent.push(t);
    this.script?.(this);
  }
  destroy(): void {
    this.destroyed = true;
  }
  say(m: unknown): void {
    this.#onMessage?.(typeof m === 'string' ? m : JSON.stringify(m));
  }
  end(): void {
    this.#onEnd?.();
  }
}

describe('asking the relays', () => {
  const SUB = 'nutflix-update';
  const one = (
    script: (s: FakeSocket) => void,
  ): { connect: RelayConnect; socket: () => FakeSocket } => {
    let socket: FakeSocket | null = null;
    return {
      connect: () => (socket = new FakeSocket(script)),
      socket: () => socket as unknown as FakeSocket,
    };
  };

  it('asks for exactly the release key, the kind and the d tag', async () => {
    const f = one((s) => {
      s.say(['EOSE', SUB]);
    });
    await fetchNotices(ROOT, f.connect);
    expect(JSON.parse(f.socket().sent[0] ?? '')).toEqual([
      'REQ',
      SUB,
      { kinds: [NOTICE_KIND], authors: [PK], '#d': [NOTICE_D], limit: 8 },
    ]);
    expect(f.socket().destroyed).toBe(true);
  });

  it('collects events until EOSE, and counts the relay as reached', async () => {
    const f = one((s) => {
      s.say(['EVENT', SUB, { a: 1 }]);
      s.say(['EVENT', SUB, { a: 2 }]);
      s.say(['EOSE', SUB]);
      s.say(['EVENT', SUB, { a: 3 }]);
    });
    expect(await fetchNotices(ROOT, f.connect)).toEqual({
      events: [{ a: 1 }, { a: 2 }],
      reached: 1,
    });
  });

  it('ignores another subscription, junk, and a NOTICE', async () => {
    const f = one((s) => {
      s.say('not json');
      s.say(['EVENT', 'other', { a: 1 }]);
      s.say(['NOTICE', 'hello']);
      s.say({ not: 'an array' });
      s.say(['CLOSED', SUB, 'no']);
    });
    expect(await fetchNotices(ROOT, f.connect)).toEqual({ events: [], reached: 1 });
  });

  it('counts a refused connection and a silent close as not reached', async () => {
    const thrown: RelayConnect = () => {
      throw new Error('refused');
    };
    expect(await fetchNotices(ROOT, thrown)).toEqual({ events: [], reached: 0 });
    const f = one((s) => {
      s.end();
    });
    expect((await fetchNotices(ROOT, f.connect)).reached).toBe(0);
  });

  it('stops at its timeout', async () => {
    const f = one(() => undefined);
    expect(await fetchNotices(ROOT, f.connect, 10)).toEqual({ events: [], reached: 0 });
    expect(f.socket().destroyed).toBe(true);
  });

  it('stops on a message over the limit, on too many bytes, and on too many events', async () => {
    const huge = one((s) => {
      s.say(`["EVENT","${SUB}","${'x'.repeat(MAX_RELAY_MESSAGE_BYTES)}"]`);
      s.say(['EVENT', SUB, { late: true }]);
    });
    expect((await fetchNotices(ROOT, huge.connect, 50)).events).toEqual([]);
    const flood = one((s) => {
      const big = 'x'.repeat(MAX_RELAY_MESSAGE_BYTES - 100);
      for (let i = 0; i < Math.ceil(MAX_RELAY_BYTES / big.length) + 2; i++)
        s.say(['EVENT', SUB, big]);
    });
    expect((await fetchNotices(ROOT, flood.connect, 50)).events.length).toBeLessThanOrEqual(
      Math.ceil(MAX_RELAY_BYTES / (MAX_RELAY_MESSAGE_BYTES - 100)),
    );
    const many = one((s) => {
      for (let i = 0; i < MAX_RELAY_EVENTS + 5; i++) s.say(['EVENT', SUB, { i }]);
    });
    expect((await fetchNotices(ROOT, many.connect)).events).toHaveLength(MAX_RELAY_EVENTS);
  });
});

// ---- the gate --------------------------------------------------------------------------------

interface Harness {
  gate: UpdateGate;
  deps: GateDeps;
  updater: { next: string | null; nextVersion: string | null; app?: string; calls: number };
  statuses: UpdateStatus[];
  floors: Floor[];
  last(): UpdateStatus | undefined;
}

const NEXT = '/data/pear-runtime/next/7.0';
const NEXT_FILE = `${NEXT}/by-arch/linux-x64/app/Nutflix.AppImage`;
const APP = '/home/u/.local/bin/Nutflix.AppImage';

function harness(
  events: unknown[],
  over: Partial<GateDeps> & { reached?: number; floor?: Floor | null; swap?: boolean } = {},
): Harness {
  const files = new Map<string, string>([
    [NEXT_FILE, SHA],
    [APP, 'old'.padEnd(64, '0')],
  ]);
  const updater = {
    next: NEXT as string | null,
    nextVersion: '1.0.2' as string | null,
    app: APP,
    calls: 0,
    applyUpdate(): Promise<void> {
      updater.calls++;
      if (over.swap !== false) files.set(APP, files.get(NEXT_FILE) ?? '');
      return Promise.resolve();
    },
  };
  const statuses: UpdateStatus[] = [];
  const floors: Floor[] = [];
  let floor = over.floor ?? null;
  const deps: GateDeps = {
    root: ROOT,
    updater,
    host: 'linux-x64',
    name: 'Nutflix.AppImage',
    artifact: ARTIFACT,
    proof: 'sha256',
    hash: (p) => {
      const v = files.get(p);
      return v === undefined ? Promise.reject(new Error('no file')) : Promise.resolve(v);
    },
    fetchNotices: () => Promise.resolve({ events, reached: over.reached ?? 1 }),
    readFloor: () => Promise.resolve(floor),
    writeFloor: (f) => {
      floor = f;
      floors.push(f);
      return Promise.resolve();
    },
    now: () => NOW * 1000,
    status: (s) => statuses.push(s),
    join: (...p) => p.join('/'),
    basename: (p) => basename(p),
    ...over,
  };
  return {
    gate: new UpdateGate(deps),
    deps,
    updater,
    statuses,
    floors,
    last: () => statuses[statuses.length - 1],
  };
}

describe('the gate', () => {
  it('builds the versioned link from the next directory, the numbers swapped', () => {
    expect(verlinkOf('/x/next/7.0', KEY, basename)).toBe(`pear://0.7.${KEY}`);
    expect(verlinkOf('/x/next/12.3', KEY, basename)).toBe(`pear://3.12.${KEY}`);
    for (const bad of ['/x/next/7', '/x/next/a.b', '/x/next/7.0.1', '/x/next/-7.0', '/x/next/'])
      expect(() => verlinkOf(bad, KEY, basename)).toThrow();
  });

  it('names a platform artifact', () => {
    expect(artifactName('linux-x64', 'Nutflix.AppImage')).toBe('Nutflix-linux-x64.AppImage');
    expect(artifactName('darwin-arm64', 'Nutflix.app')).toBe('Nutflix-darwin-arm64.app');
    expect(artifactName('win32-x64', 'Nutflix.msix')).toBe('Nutflix-win32-x64.msix');
  });

  it('applies on an exact match, and proves the swap by hash', async () => {
    const h = harness([signed()]);
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(1);
    expect(h.statuses.map((s) => s.state)).toEqual(['checking', 'applying', 'applied']);
    expect(h.last()).toEqual({ state: 'applied', proof: 'sha256', version: '1.0.2' });
  });

  it.each<[string, unknown[], { reached?: number }, string]>([
    ['no notice', [], {}, 'no-notice'],
    ['an unreachable relay', [], { reached: 0 }, 'relay-unreachable'],
    ['a wrong hash', [signed({ sha256: 'cd'.repeat(32) })], {}, 'hash-mismatch'],
    ['a wrong link', [signed({ verlink: `pear://0.8.${KEY}` })], {}, 'link-mismatch'],
    ['a wrong version', [signed({ version: '1.0.3' })], {}, 'version-mismatch'],
    ['a wrong signer', [signed({}, OTHER)], {}, 'no-notice'],
  ])('holds on %s and never calls applyUpdate', async (_n, events, o, reason) => {
    const h = harness(events, o);
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(0);
    expect(h.last()).toMatchObject({ state: 'held', reason });
  });

  it('holds a replayed older notice', async () => {
    const h = harness([signed({ createdAt: NOW - 100 })], {
      floor: { createdAt: NOW - 50, id: 'ef'.repeat(32) },
    });
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(0);
    expect(h.last()).toMatchObject({ state: 'held', reason: 'stale-notice' });
  });

  it('raises the floor to the newest valid notice, even one it holds, and never lowers it', async () => {
    const e = signed({ createdAt: NOW - 10, sha256: 'cd'.repeat(32) });
    const h = harness([e]);
    await h.gate.onUpdated();
    expect(h.floors).toEqual([{ createdAt: NOW - 10, id: e['id'] }]);
    const low = harness([signed({ createdAt: NOW - 20 })], {
      floor: { createdAt: NOW - 10, id: 'ef'.repeat(32) },
    });
    await low.gate.onUpdated();
    expect(low.floors).toEqual([]);
  });

  it('does not let a forged notice move the floor', async () => {
    const h = harness([signed({ createdAt: NOW }, OTHER)]);
    await h.gate.onUpdated();
    expect(h.floors).toEqual([]);
  });

  it('holds when the file changes between the check and the apply', async () => {
    let n = 0;
    const h = harness([signed()], {
      hash: () => Promise.resolve(++n === 1 ? SHA : 'ee'.repeat(32)),
    });
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(0);
    expect(h.last()).toMatchObject({ state: 'held', reason: 'changed' });
  });

  it('holds when next moves during the second hash, and checks the new build', async () => {
    let n = 0;
    const h: Harness = harness([signed()], {
      hash: () => {
        n++;
        if (n === 2) h.updater.next = '/data/pear-runtime/next/9.0';
        return Promise.resolve(SHA);
      },
    });
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(0);
    // The second pass judged `next/9.0`, whose link the notice does not name.
    expect(h.statuses.filter((s) => s.state === 'held').map((s) => s.reason)).toEqual([
      'changed',
      'link-mismatch',
    ]);
  });

  it('has no await between the last check of next and the call to applyUpdate', () => {
    const src = readFileSync(fileURLToPath(new URL('../update/gate.ts', import.meta.url)), 'utf8');
    const from = src.indexOf('if (u.next !== next || u.nextVersion !== version)');
    const to = src.indexOf('const applying = u.applyUpdate();');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(src.slice(from, to)).not.toMatch(/\bawait\b/);
  });

  it('reports failure when applyUpdate returned but the installed app is not the build', async () => {
    const h = harness([signed()], { swap: false });
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(1);
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'swap-unproved' });
  });

  it('reports failure when applyUpdate rejects, and does not try again', async () => {
    const h = harness([signed()]);
    h.updater.calls = 0;
    (h.deps.updater as { applyUpdate: () => Promise<void> }).applyUpdate = () => {
      h.updater.calls++;
      return Promise.reject(new Error('EXDEV'));
    };
    await h.gate.onUpdated();
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(1);
    expect(h.last()).toMatchObject({ state: 'failed', reason: 'error' });
  });

  it('on Windows reports the deployment, and hashes no installed path', async () => {
    const hashed: string[] = [];
    const h = harness([signed()], {
      proof: 'msix-deployed',
      hash: (p) => {
        hashed.push(p);
        return Promise.resolve(SHA);
      },
    });
    await h.gate.onUpdated();
    expect(h.last()).toEqual({ state: 'applied', proof: 'msix-deployed', version: '1.0.2' });
    expect(hashed).toEqual([NEXT_FILE, NEXT_FILE]);
  });

  it('holds on any failure: a hash that throws, a relay fetch that throws, a bad next', async () => {
    for (const over of [
      { hash: () => Promise.reject(new Error('EIO')) },
      { fetchNotices: () => Promise.reject(new Error('boom')) },
    ] as Partial<GateDeps>[]) {
      const h = harness([signed()], over);
      await h.gate.onUpdated();
      expect(h.updater.calls).toBe(0);
      expect(h.last()).toMatchObject({ state: 'held', reason: 'error' });
    }
    const h = harness([signed()]);
    h.updater.next = '/data/pear-runtime/next/not-a-version';
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(0);
    expect(h.last()).toMatchObject({ state: 'held', reason: 'error' });
    const none = harness([signed()]);
    none.updater.next = null;
    await none.gate.onUpdated();
    expect(none.updater.calls).toBe(0);
  });

  it('decides the same with an unreadable or failing floor store', async () => {
    const h = harness([signed()], {
      readFloor: () => Promise.reject(new Error('EACCES')),
      writeFloor: () => Promise.reject(new Error('EROFS')),
    });
    await h.gate.onUpdated();
    expect(h.last()).toMatchObject({ state: 'applied' });
  });

  it('never shows a version that is not plain', async () => {
    const h = harness([]);
    h.updater.nextVersion = '1.0.2<script>';
    await h.gate.onUpdated();
    expect(h.statuses.every((s) => s.version === undefined)).toBe(true);
  });

  it('runs one check at a time, and one more for an update that came during it', async () => {
    let release: (() => void) | undefined;
    const started = vi.fn();
    const h = harness([], {
      fetchNotices: () => {
        started();
        return new Promise((resolve) => {
          release = () => {
            resolve({ events: [], reached: 1 });
          };
        });
      },
    });
    const first = h.gate.onUpdated();
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledTimes(1);
    });
    await h.gate.onUpdated();
    expect(started).toHaveBeenCalledTimes(1);
    release?.();
    await vi.waitFor(() => {
      expect(started).toHaveBeenCalledTimes(2);
    });
    release?.();
    await first;
    expect(started).toHaveBeenCalledTimes(2);
  });

  it('applies at most once', async () => {
    const h = harness([signed()]);
    await h.gate.onUpdated();
    await h.gate.onUpdated();
    expect(h.updater.calls).toBe(1);
  });
});

// ---- the status, and main's side ---------------------------------------------------------------

describe('the status main passes on', () => {
  it('takes the fixed words', () => {
    expect(
      parseUpdateStatus({ state: 'held', reason: 'no-notice', version: '1.0.2', refused: 2 }),
    ).toEqual({
      state: 'held',
      reason: 'no-notice',
      version: '1.0.2',
      refused: 2,
    });
    expect(parseUpdateStatus({ state: 'applied', proof: 'sha256' })).toEqual({
      state: 'applied',
      proof: 'sha256',
    });
  });

  it.each([
    null,
    [],
    { state: 'nope' },
    { state: 'held', reason: 'because' },
    { state: 'held', version: 'pear://x' },
    { state: 'held', refused: -1 },
    { state: 'held', refused: 1.5 },
    { state: 'held', refused: 1001 },
    { state: 'applied', proof: 'trust-me' },
    { state: 'held', link: 'pear://x' },
  ])('refuses %j', (x) => {
    expect(parseUpdateStatus(x)).toBeNull();
  });

  const start: UpdateStart = {
    dir: '/d/update',
    version: '0.1.1',
    name: 'Nutflix.AppImage',
    app: '/h/Nutflix.AppImage',
    host: 'linux-x64',
  };

  it('takes a good start message, and refuses each bad field', () => {
    expect(parseUpdateStart(start)).toEqual(start);
    for (const patch of [
      { dir: '' },
      { dir: 'x'.repeat(4097) },
      { version: '1' },
      { name: '../x' },
      { name: 'Other.AppImage' },
      { app: '' },
      { host: 'freebsd-x64' },
    ])
      expect(parseUpdateStart({ ...start, ...patch })).toBeNull();
    expect(parseUpdateStart('x')).toBeNull();
  });
});

describe("main's side of the updater", () => {
  class FakeSidecar extends EventEmitter {
    written: Uint8Array[] = [];
    destroyed = false;
    write(b: Uint8Array): boolean {
      this.written.push(b);
      return true;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }

  const start: UpdateStart = {
    dir: '/d',
    version: '0.1.1',
    name: 'Nutflix.AppImage',
    app: '/a/Nutflix.AppImage',
    host: 'linux-x64',
  };

  const boot = (): {
    sidecar: FakeSidecar;
    statuses: UpdateStatus[];
    logs: string[];
  } => {
    const sidecar = new FakeSidecar();
    const statuses: UpdateStatus[] = [];
    const logs: string[] = [];
    startUpdater({
      entry: '/e.cjs',
      run: () => sidecar,
      start,
      onStatus: (s) => statuses.push(s),
      log: (n) => logs.push(n),
    });
    return { sidecar, statuses, logs };
  };

  it('sends one start frame, and passes on a checked status', () => {
    const { sidecar, statuses } = boot();
    const got: unknown[] = [];
    const d = new FrameDecoder((m) => got.push(m));
    for (const w of sidecar.written) d.push(w);
    expect(got).toEqual([{ op: 'start', start }]);
    sidecar.emit(
      'data',
      encodeFrame({ op: 'status', status: { state: 'held', reason: 'no-notice' } }),
    );
    expect(statuses).toEqual([{ state: 'held', reason: 'no-notice' }]);
  });

  it('ends a process that sends a status it does not know', () => {
    const { sidecar, statuses, logs } = boot();
    sidecar.emit('data', encodeFrame({ op: 'status', status: { state: 'pwned' } }));
    expect(statuses).toEqual([]);
    expect(logs).toContain('update-worker-corrupt');
    expect(sidecar.destroyed).toBe(true);
  });

  it('ends a process that sends an oversized or corrupt frame', () => {
    const a = boot();
    a.sidecar.emit('data', encodeFrame({ op: 'status', pad: 'x'.repeat(2000) }));
    expect(a.sidecar.destroyed).toBe(true);
    const b = boot();
    b.sidecar.emit('data', new Uint8Array([0, 0, 0, 2, 0xff, 0xff]));
    expect(b.sidecar.destroyed).toBe(true);
  });

  it('names its exit apart from the data worker, so a dead updater is not a broken app', () => {
    const { sidecar, logs } = boot();
    sidecar.emit('exit', 1);
    expect(logs).toEqual(['update-worker-exit']);
  });

  const base = {
    platform: 'linux',
    arch: 'x64',
    execPath: '/tmp/.mount/usr/lib/Nutflix/Nutflix',
    appImage: '/home/u/.local/bin/Nutflix.AppImage' as string | undefined,
    windowsStore: false,
    productName: 'Nutflix',
  };

  it('knows what is installed on each platform', () => {
    expect(installedApp(base)).toEqual({
      name: 'Nutflix.AppImage',
      app: '/home/u/.local/bin/Nutflix.AppImage',
      host: 'linux-x64',
    });
    expect(
      installedApp({
        ...base,
        platform: 'darwin',
        arch: 'arm64',
        execPath: '/Users/u/Applications/Nutflix.app/Contents/MacOS/Nutflix',
      }),
    ).toEqual({
      name: 'Nutflix.app',
      app: '/Users/u/Applications/Nutflix.app',
      host: 'darwin-arm64',
    });
    expect(
      installedApp({
        ...base,
        platform: 'win32',
        execPath: 'C:\\Program Files\\WindowsApps\\x\\app\\Nutflix.exe',
        windowsStore: true,
      }),
    ).toMatchObject({ name: 'Nutflix.msix', host: 'win32-x64' });
  });

  it('starts nothing for a run that is not an installed package', () => {
    expect(installedApp({ ...base, appImage: undefined })).toBeNull();
    expect(installedApp({ ...base, appImage: 'relative/Nutflix.AppImage' })).toBeNull();
    expect(installedApp({ ...base, appImage: '/home/u/Other.AppImage' })).toBeNull();
    expect(installedApp({ ...base, platform: 'darwin', execPath: '/x/Nutflix' })).toBeNull();
    expect(installedApp({ ...base, platform: 'win32', windowsStore: false })).toBeNull();
    expect(installedApp({ ...base, platform: 'freebsd' })).toBeNull();
  });
});

describe('the window hears an update only from main', () => {
  const setup = (): { gate: RpcGate; frames: Record<string, unknown>[] } => {
    const frames: Record<string, unknown>[] = [];
    const d = new FrameDecoder((m) => frames.push(m as Record<string, unknown>));
    const gate = new RpcGate({
      toWorker: () => undefined,
      toWindow: (_id, f) => {
        d.push(f);
      },
      closeWindow: () => undefined,
    });
    gate.attach(1, MAIN_WINDOW_POLICY);
    return { gate, frames };
  };

  it('passes main’s status to a window whose policy lists it', () => {
    const { gate, frames } = setup();
    gate.fromMain('update', { state: 'held' });
    expect(frames).toEqual([{ state: 'held', op: 'ev', e: 'update' }]);
  });

  it('drops an `update` event from the worker: a compromised worker cannot claim a verified update', () => {
    const { gate, frames } = setup();
    gate.fromWorker(encodeFrame({ op: 'ev', e: 'update', state: 'applied' }));
    expect(frames).toEqual([]);
  });

  it('sends no event main has not listed, and none to a window without the list', () => {
    const { gate, frames } = setup();
    gate.fromMain('status', { state: 'x' });
    expect(frames).toEqual([]);
    const other: unknown[] = [];
    const g = new RpcGate({
      toWorker: () => undefined,
      toWindow: (_id, f) => other.push(f),
      closeWindow: () => undefined,
    });
    g.attach(2, { methods: new Set(), events: new Set(['update']), maxInflight: 1 });
    g.fromMain('update', { state: 'held' });
    expect(other).toEqual([]);
  });

  it('gives the window no method that reaches the updater', () => {
    for (const m of MAIN_WINDOW_POLICY.methods) expect(m).not.toMatch(/update/i);
    expect([...MAIN_WINDOW_POLICY.events]).not.toContain('update');
  });
});
