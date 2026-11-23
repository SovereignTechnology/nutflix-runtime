/**
 * The argument guards of every method added for seeding, publishing and the signer. The renderer
 * is untrusted: each of these is what a compromised page could send, and each must be refused
 * before a handler runs. Valid requests are checked too, so that a guard cannot pass by refusing
 * everything.
 */
import { describe, expect, it } from 'vitest';

import { isRequest } from '../guards.js';
import {
  MAX_BUNKER_URI,
  MAX_DESCRIPTION,
  MAX_OFFERED_CHUNK_CHARS,
  MAX_OFFERED_FILE_BYTES,
  MAX_PASSPHRASE,
  MAX_STUDIO_HEIGHT,
  MAX_STUDIO_SIZES,
  MAX_TITLE,
  MAX_VIDEO_TAG,
  MAX_VIDEO_TAGS,
  MIN_PASSPHRASE,
} from '../protocol.js';

const req = (m: string, a: unknown): unknown => ({ op: 'req', id: 1, m, a });
const shown = (a: unknown): string =>
  (JSON.stringify(a) as string | undefined)?.slice(0, 80) ?? 'undefined';
const ok = (m: string, a: unknown): void => {
  expect(isRequest(req(m, a)), `${m} ${shown(a)}`).toBe(true);
};
const no = (m: string, a: unknown): void => {
  expect(isRequest(req(m, a)), `${m} ${shown(a)}`).toBe(false);
};

const VIDEO = `nfx:testnet:1:nutflix-${'a'.repeat(32)}`;
const SHA = 'ab'.repeat(32);
const SID = 'cd'.repeat(16);
const PEER = { t: 'hyperdht', peer: 'ef'.repeat(32), bind: '01'.repeat(64) };
const MANIFEST = {
  id: SHA,
  pubkey: SHA,
  sig: '02'.repeat(64),
  kind: 38504,
  created_at: 1_800_000_000,
  tags: [['d', VIDEO]],
  content: '',
};

describe('no-argument methods', () => {
  it.each([
    'signer.status',
    'signer.lock',
    'seeding.status',
    'seeding.beacons',
    'studio.ffmpeg',
    'studio.cancel',
  ])('%s takes none', (m) => {
    ok(m, {});
    no(m, { x: 1 });
    no(m, []);
    no(m, null);
    no(m, JSON.parse('{"__proto__":{"x":1}}'));
  });
});

describe('passphrases', () => {
  it.each(['signer.local.create', 'signer.local.unlock'])('%s', (m) => {
    ok(m, { passphrase: 'p'.repeat(MIN_PASSPHRASE) });
    ok(m, { passphrase: 'p'.repeat(MAX_PASSPHRASE) });
    ok(m, { passphrase: 'pàss phräse ☃ 1234' });
    no(m, { passphrase: 'p'.repeat(MIN_PASSPHRASE - 1) });
    no(m, { passphrase: 'p'.repeat(MAX_PASSPHRASE + 1) });
    no(m, { passphrase: 'with a\nnewline in it' });
    no(m, { passphrase: 'with a\u0000nul in it' });
    no(m, { passphrase: 12345678 });
    no(m, {});
    no(m, { passphrase: 'long enough', extra: true });
  });
});

describe('signer.nip46.connect', () => {
  it('takes a bunker URI, bounded', () => {
    ok('signer.nip46.connect', { uri: `bunker://${SHA}?relay=wss://r.example` });
    no('signer.nip46.connect', { uri: `https://${SHA}` });
    no('signer.nip46.connect', { uri: `bunker://${SHA}?relay=wss://r.example x` });
    no('signer.nip46.connect', { uri: `bunker://${'a'.repeat(MAX_BUNKER_URI)}` });
    no('signer.nip46.connect', { uri: 7 });
    no('signer.nip46.connect', {});
  });
});

describe('signer.check and signer.sign', () => {
  const event = { kind: 38504, created_at: 1_800_000_000, tags: [['d', VIDEO]], content: '' };

  it('signer.check names a video, and takes no event from anyone', () => {
    ok('signer.check', { video: VIDEO });
    no('signer.check', { event });
    no('signer.check', { video: 'nope' });
    no('signer.check', { video: VIDEO, extra: 1 });
  });

  it('signer.sign takes an allow-listed event and the key the user approved', () => {
    ok('signer.sign', { event, signer: SHA });
    no('signer.sign', { event });
    no('signer.sign', { event, signer: 'x' });
    no('signer.sign', { event, signer: SHA.toUpperCase() });
    no('signer.sign', { event: { ...event, kind: 1 }, signer: SHA });
    no('signer.sign', { event: { ...event, kind: 20464 }, signer: SHA });
    no('signer.sign', { event: { ...event, pubkey: SHA }, signer: SHA });
    no('signer.sign', { event, signer: SHA, extra: 1 });
  });
});

describe('titles and tags, as a person will read them', () => {
  const a = { source: SID, title: 'A title', description: '', tags: [], sizes: [720] };
  const title = (t: string): unknown => ({ ...a, title: t });

  it.each([
    ['a line separator', 'Cat\u2028Signed by: someone'],
    ['a paragraph separator', 'Cat\u2029more'],
    ['a newline', 'a\nb'],
    ['a control character', 'a\u0007b'],
    ['a C1 control', 'a\u0085b'],
    ['the Arabic letter mark', 'a\u061cb'],
    ['a left-to-right mark', 'a\u200eb'],
    ['a right-to-left mark', 'a\u200fb'],
    ['a right-to-left override', 'a\u202eb'],
    ['a directional isolate', 'a\u2067b\u2069'],
    ['a tag character', 'a\u{E0041}b'],
    ['an unpaired surrogate', 'a\ud800b'],
    ['only invisible characters', '\u200b\u200d\u2060'],
    ['only a soft hyphen', '\u00ad'],
    ['only spaces and a joiner', '  \u200d '],
  ])('refuses a title with %s', (_name, t) => {
    no('studio.publish', title(t));
  });

  it.each([
    ['an emoji sequence', 'Family 👨\u200d👩\u200d👧'],
    ['Persian with a zero-width non-joiner', 'می\u200cخواهم'],
    ['Hindi with a joiner', 'क्\u200dष'],
    ['plain accents', 'Café crème'],
  ])('keeps a title with %s', (_name, t) => {
    ok('studio.publish', title(t));
  });

  it('holds a tag to the same rules', () => {
    ok('studio.publish', { ...a, tags: ['cats'] });
    no('studio.publish', { ...a, tags: ['a\u202eb'] });
    no('studio.publish', { ...a, tags: ['a\u2028b'] });
    no('studio.publish', { ...a, tags: ['\u200b'] });
  });
});

describe('init', () => {
  it('takes whether this shell may hold a sealed key', () => {
    ok('init', { v: 1, storage: '/home/user/worker', localKey: true });
    ok('init', { v: 1, storage: '/home/user/worker' });
    no('init', { v: 1, storage: '/home/user/worker', localKey: 'yes' });
  });
});

describe('seeding', () => {
  it('seeding.set', () => {
    ok('seeding.set', { watched: true });
    no('seeding.set', { watched: 'true' });
    no('seeding.set', { watched: 1 });
    no('seeding.set', {});
  });

  it('seeding.stop', () => {
    ok('seeding.stop', { video: VIDEO });
    no('seeding.stop', { video: 'nope' });
    no('seeding.stop', { video: `${VIDEO}/../x` });
    no('seeding.stop', { video: VIDEO.toUpperCase() });
  });

  it('seeding.watch', () => {
    const a = { sid: SID, manifest: MANIFEST, peers: [PEER] };
    ok('seeding.watch', a);
    ok('seeding.watch', { ...a, peers: [] });
    no('seeding.watch', { manifest: MANIFEST, peers: [PEER] });
    no('seeding.watch', { ...a, sid: 'x' });
    no('seeding.watch', { ...a, manifest: { ...MANIFEST, kind: 1 } });
    no('seeding.watch', { ...a, manifest: { ...MANIFEST, sig: 'x' } });
    no('seeding.watch', { ...a, manifest: { ...MANIFEST, extra: 1 } });
    no('seeding.watch', { ...a, peers: [PEER, PEER] });
    no('seeding.watch', { ...a, peers: [{ ...PEER, t: 'iroh' }] });
    no('seeding.watch', { ...a, peers: Array.from({ length: 17 }, () => PEER) });
    no('seeding.watch', { sid: SID, manifest: MANIFEST });
    no('seeding.watch', { sid: SID, peers: [] });
  });

  it('seeding.segment', () => {
    const a = { sid: SID, sha256: SHA, size: 8, offset: 0, data: 'AAAA' };
    ok('seeding.segment', a);
    no('seeding.segment', { ...a, sid: 'x' });
    no('seeding.segment', { ...a, sha256: 'AB'.repeat(32) });
    no('seeding.segment', { ...a, size: 0 });
    no('seeding.segment', { ...a, size: MAX_OFFERED_FILE_BYTES + 1 });
    no('seeding.segment', { ...a, offset: -1 });
    no('seeding.segment', { ...a, offset: 8 });
    no('seeding.segment', { ...a, offset: 1.5 });
    no('seeding.segment', { ...a, data: '' });
    no('seeding.segment', { ...a, data: 'AAA' });
    no('seeding.segment', { ...a, data: 'A*AA' });
    no('seeding.segment', { ...a, data: 'A'.repeat(MAX_OFFERED_CHUNK_CHARS + 4) });
    no('seeding.segment', { ...a, path: '/etc/passwd' });
  });
});

describe('Studio', () => {
  it('studio.source takes an absolute path of at least two names', () => {
    ok('studio.source', { path: '/home/user/clip.mp4' });
    ok('studio.source', { path: 'C:\\Users\\me\\clip.mp4' });
    no('studio.source', { path: 'clip.mp4' });
    no('studio.source', { path: '/clip.mp4' });
    no('studio.source', { path: '/home/../etc/passwd' });
    no('studio.source', { path: '/home/user/a\nb.mp4' });
    no('studio.source', {});
  });

  it('studio.probe takes a token, never a path', () => {
    ok('studio.probe', { source: SID });
    no('studio.probe', { source: '/home/user/clip.mp4' });
    no('studio.probe', { path: '/home/user/clip.mp4' });
    no('studio.probe', { source: SID, path: '/x/y' });
  });

  it('studio.publish', () => {
    const a = { source: SID, title: 'A title', description: '', tags: ['a'], sizes: [720] };
    ok('studio.publish', a);
    ok('studio.publish', { ...a, description: 'two\nlines', tags: [] });
    no('studio.publish', { ...a, source: '/home/user/clip.mp4' });
    no('studio.publish', { ...a, path: '/home/user/clip.mp4' });
    no('studio.publish', { ...a, title: '' });
    no('studio.publish', { ...a, title: '   ' });
    no('studio.publish', { ...a, title: 'x'.repeat(MAX_TITLE + 1) });
    no('studio.publish', { ...a, title: 'a\nb' });
    no('studio.publish', { ...a, description: 'x'.repeat(MAX_DESCRIPTION + 1) });
    no('studio.publish', {
      ...a,
      tags: Array.from({ length: MAX_VIDEO_TAGS + 1 }, (_, i) => `t${String(i)}`),
    });
    no('studio.publish', { ...a, tags: ['x'.repeat(MAX_VIDEO_TAG + 1)] });
    no('studio.publish', { ...a, tags: ['two words'] });
    no('studio.publish', { ...a, tags: ['a', 'a'] });
    no('studio.publish', { ...a, sizes: [] });
    no('studio.publish', { ...a, sizes: [720, 720] });
    no('studio.publish', { ...a, sizes: [1] });
    no('studio.publish', { ...a, sizes: [MAX_STUDIO_HEIGHT + 2] });
    no('studio.publish', { ...a, sizes: [720.5] });
    no('studio.publish', {
      ...a,
      sizes: Array.from({ length: MAX_STUDIO_SIZES + 1 }, (_, i) => 100 + i * 2),
    });
    no('studio.publish', { ...a, price: 100 });
    no('studio.publish', { ...a, satsPerBlock: 1 });
  });
});
