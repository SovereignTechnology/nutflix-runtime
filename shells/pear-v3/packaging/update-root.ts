/**
 * Which trust root a package may be built with (`src/update/root.ts` says what one is).
 *
 * The RELEASE path (`package.ts stage|package|make|build`) always bakes in `releaseRoot()`: the
 * production key and notice relays, written here so that changing them is a reviewed commit. No
 * option, environment variable or file can name another, and the bundle is read back afterwards.
 * `RELEASE_UPGRADE_LINK` is `null`, so a shipped build starts no updater. Setting it is the
 * maintainer's step, once the production `pear multisig` link exists.
 *
 * The TEST path (`package.ts test-build`) takes a root from a file, for CI's update proof. It is
 * refused unless the key is NOT the production key and every address is on loopback.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  BAKED_PATTERN,
  decodeBakedRoot,
  parseTrustRoot,
  type TrustRoot,
} from '../src/update/root.ts';
import { STAGED } from './identity.ts';

/** The SovTech release key: nutflix-pear's `SOVTECH_NPUB`, as hex (a test pins the two together). */
export const RELEASE_PUBKEY = '83d8bce2f7d6966f306e6f1a712497cf0a2c77d073923136a0e2bb54963b3434';

/**
 * Where a notice is read from: nutflix-pear's `RELEASE_RELAYS` (where its publish script sends
 * every notice; a test pins them), after this network's own relay.
 */
export const RELEASE_NOTICE_RELAYS: readonly string[] = [
  'wss://relay.nutflix.xyz',
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

/** The production upgrade link. `null` until the owner has provisioned one: no updater runs. */
export const RELEASE_UPGRADE_LINK: string | null = null;

export function releaseRoot(): TrustRoot {
  return parseTrustRoot({
    v: 1,
    channel: 'release',
    pubkey: RELEASE_PUBKEY,
    relays: [...RELEASE_NOTICE_RELAYS],
    upgrade: RELEASE_UPGRADE_LINK,
    dht: null,
    delayMs: null,
  });
}

/** Throws unless `root` is exactly the production root. */
export function assertReleaseRoot(root: TrustRoot): void {
  const want = releaseRoot();
  if (root.channel !== 'release') throw new Error('a release build needs the release channel');
  if (root.pubkey !== RELEASE_PUBKEY)
    throw new Error('a release build is signed for by the production key, and no other');
  if (JSON.stringify(root) !== JSON.stringify(want))
    throw new Error('a release build carries the production root, unchanged');
}

/** Throws unless `root` is a throwaway root that cannot reach or pass for production. */
export function assertTestRoot(root: TrustRoot): void {
  if (root.channel !== 'test') throw new Error('a test build needs the test channel');
  if (root.pubkey === RELEASE_PUBKEY) throw new Error('a test build never uses the production key');
  if (root.upgrade === null) throw new Error('a test build needs an upgrade link');
}

export function testRootFromText(text: string): TrustRoot {
  const root = parseTrustRoot(JSON.parse(text));
  assertTestRoot(root);
  return root;
}

/** The one root a bundle holds; throws on none, or on two that differ. */
export function bakedRootIn(bundle: string): TrustRoot {
  const found = new Set(bundle.match(BAKED_PATTERN) ?? []);
  if (found.size !== 1) throw new Error(`the bundle holds ${String(found.size)} update roots`);
  const [only] = found;
  return decodeBakedRoot(only ?? '');
}

/** Reads the staged updater back and refuses a root that is not what this build is allowed. */
export function assertStagedRoot(
  stageDir: string,
  expected: TrustRoot,
  mode: 'release' | 'test',
): void {
  const baked = bakedRootIn(readFileSync(join(stageDir, STAGED.updateWorker), 'utf8'));
  if (JSON.stringify(baked) !== JSON.stringify(expected))
    throw new Error('the staged updater does not hold the root it was given');
  if (mode === 'release') assertReleaseRoot(baked);
  else assertTestRoot(baked);
}
