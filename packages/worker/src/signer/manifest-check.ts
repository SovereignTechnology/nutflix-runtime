/**
 * What the renderer may have the user's signer sign. The kind is on the allow-list
 * (`SIGNABLE_KINDS`, `../guards.ts`), and that alone would let a compromised page publish any
 * manifest under the user's name, so a kind-38504 request must also be the manifest of a video
 * THIS node packaged in Studio: stored, with this `root` and `segs`, free, and if it was signed
 * before, by the same key. The page may still word the title and description: they are the user's
 * text, and the page is where they type it.
 */
import { nfx } from '@sovit/core';
import type { NostrEvent } from '@sovit/core';
import type { NfxStore } from '@sovit/seeder';

import { fail } from '../errors.js';
import type { UnsignedEventWire } from '../protocol.js';
import type { SeedPolicy } from '../nfx/seed-policy.js';

const NOT_FREE = ['price_hint', 'key_price', 'split', 'mint', 'cashu_key', 'free_seeder'];

function single(e: UnsignedEventWire, name: string): string {
  const found = e.tags.filter((t) => t[0] === name);
  const value = found[0]?.[1];
  if (found.length !== 1 || value === undefined) fail('invalid-argument', 'not a manifest');
  return value;
}

/** The video `event` is the manifest of. Throws `invalid-argument` for anything else. */
export function checkManifestDraft(
  event: UnsignedEventWire,
  policy: SeedPolicy,
  store: NfxStore,
  signer: string | null,
): string {
  if (event.kind !== nfx.KIND_MANIFEST) fail('invalid-argument', 'not a signable kind');
  if (event.tags.some((t) => NOT_FREE.includes(t[0] ?? '')))
    fail('invalid-argument', 'only free videos are published here');
  if (single(event, 'license') !== 'open')
    fail('invalid-argument', 'only free videos are published here');
  const video = single(event, 'd');
  const addr = nfx.VideoAddr.parse(video);
  if (!addr.ok || addr.value.toString() !== video) fail('invalid-argument', 'not a manifest');
  const record = policy.record(video);
  const stored = store.get(addr.value);
  if (record?.origin !== 'published' || stored === undefined)
    fail('invalid-argument', 'this node did not package that video');
  if (single(event, 'root') !== stored.root || record.root !== stored.root)
    fail('invalid-argument', 'the manifest does not name the stored video');
  if (single(event, 'segs') !== stored.segs)
    fail('invalid-argument', 'the manifest does not name the stored video');
  if (record.author !== null && record.author !== signer)
    fail('invalid-argument', 'that video was published under another key');
  return video;
}

/** The signed result, checked as a stranger would check it, before it leaves the worker. */
export function checkSignedManifest(signed: NostrEvent, video: string, signer: string): void {
  const parsed = nfx.parseManifest(signed);
  if (
    !parsed.ok ||
    !nfx.isListable(parsed.value) ||
    parsed.value.addr.toString() !== video ||
    signed.pubkey !== signer
  )
    fail('invalid-argument', 'the signed manifest does not verify');
}
