/**
 * The release notice, UNSIGNED: a kind-30071 event for the owner to sign with the release key and
 * publish (`docs/release.md`). Nothing here signs, holds a key or talks to a relay. `id` and `sig`
 * are empty until the signer fills them.
 *
 * The shape is nutflix-pear's release notice (`scripts/release-manifest.mjs`) with the versioned
 * link added, and is what `src/update/notice.ts` reads. A shared vector
 * (`__tests__/fixtures/nutflix-runtime-notice.vector.json`) holds the two repositories to it.
 */
import { createHash } from 'node:crypto';

import { RELEASE_PUBKEY, releaseRoot } from '../../packaging/update-root.ts';
import { MAX_ARTIFACTS } from '../../src/update/notice.ts';
import { NOTICE_D, NOTICE_KIND } from '../../src/update/root.ts';
import type { Digest } from './assemble.ts';
import { assertVerlink, assertVersion, linkKeyOf, refuse } from './guards.ts';
import { RELEASE_TARGETS } from './targets.ts';

export interface UnsignedNotice {
  readonly id: '';
  readonly pubkey: string;
  readonly created_at: number;
  readonly kind: number;
  readonly tags: readonly (readonly string[])[];
  readonly content: string;
  readonly sig: '';
}

export interface DraftInput {
  readonly version: string;
  readonly verlink: string;
  /** The full 40-hex commit the release was built from. */
  readonly commit?: string | undefined;
  readonly createdAt: number;
  readonly artifacts: readonly Digest[];
}

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

/** Bytewise (`LC_ALL=C`), as nutflix-pear sorts the sums. */
const byName = (a: Digest, b: Digest): number =>
  Buffer.compare(Buffer.from(a.name), Buffer.from(b.name));

export function sumsText(artifacts: readonly Digest[]): string {
  return [...artifacts]
    .sort(byName)
    .map((a) => `${a.sha256}  ${a.name}\n`)
    .join('');
}

/** The unsigned event for these digests. Any artifact name that is not a target's is refused. */
export function noticeDraft(o: DraftInput): UnsignedNotice {
  const version = assertVersion(o.version, 'the version');
  const verlink = assertVerlink(o.verlink, 'the versioned link');
  if (!Number.isSafeInteger(o.createdAt) || o.createdAt <= 0) refuse('created_at is not a time');
  if (o.commit !== undefined && !COMMIT.test(o.commit))
    refuse('the commit must be a full 40-hex git sha');
  if (o.artifacts.length === 0 || o.artifacts.length > MAX_ARTIFACTS)
    refuse('a notice names between one artifact and the most the app reads');
  const known = new Set(RELEASE_TARGETS.map((t) => t.noticeName));
  const seen = new Set<string>();
  for (const a of o.artifacts) {
    if (!known.has(a.name)) refuse(`${a.name} is not a target's artifact`);
    if (seen.has(a.name)) refuse(`${a.name} is named twice`);
    seen.add(a.name);
    if (!SHA256.test(a.sha256)) refuse(`${a.name}: the digest is not a sha256`);
    if (!Number.isSafeInteger(a.bytes) || a.bytes < 0) refuse(`${a.name}: bad size`);
  }
  // Once the source has a production link, a notice for another link could only ever be held.
  const production = releaseRoot().upgrade;
  if (production !== null && linkKeyOf(verlink) !== linkKeyOf(production))
    refuse(`${verlink} is not a version of the production link ${production}`);
  const sorted = [...o.artifacts].sort(byName);
  const content = sumsText(sorted);
  const tags: string[][] = [
    ['d', NOTICE_D],
    ['version', version],
    ['verlink', verlink],
  ];
  if (o.commit !== undefined) tags.push(['commit', o.commit]);
  tags.push(
    ['x', createHash('sha256').update(content, 'utf8').digest('hex')],
    ['files', String(sorted.length)],
    ['size', String(sorted.reduce((n, a) => n + a.bytes, 0))],
  );
  for (const a of sorted) tags.push(['artifact', a.name, a.sha256, String(a.bytes)]);
  return {
    id: '',
    pubkey: RELEASE_PUBKEY,
    created_at: o.createdAt,
    kind: NOTICE_KIND,
    tags,
    content,
    sig: '',
  };
}

/** `noticeDraft`, requiring exactly the five targets: what the CLI writes for a real release. */
export function releaseNoticeDraft(o: DraftInput): UnsignedNotice {
  const want = RELEASE_TARGETS.map((t) => t.noticeName).sort();
  const got = o.artifacts.map((a) => a.name).sort();
  if (JSON.stringify(want) !== JSON.stringify(got))
    refuse(`a release names the five targets, got: ${got.join(', ')}`);
  return noticeDraft(o);
}
