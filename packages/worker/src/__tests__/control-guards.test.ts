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
    ok('seeding.watch', { manifest: MANIFEST, peers: [PEER] });
    ok('seeding.watch', { manifest: MANIFEST, peers: [] });
    no('seeding.watch', { manifest: { ...MANIFEST, kind: 1 }, peers: [] });
    no('seeding.watch', { manifest: { ...MANIFEST, sig: 'x' }, peers: [] });
    no('seeding.watch', { manifest: { ...MANIFEST, extra: 1 }, peers: [] });
    no('seeding.watch', { manifest: MANIFEST, peers: [PEER, PEER] });
    no('seeding.watch', { manifest: MANIFEST, peers: [{ ...PEER, t: 'iroh' }] });
    no('seeding.watch', { manifest: MANIFEST, peers: Array.from({ length: 17 }, () => PEER) });
    no('seeding.watch', { manifest: MANIFEST });
    no('seeding.watch', { peers: [] });
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
