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
 * refused unless the key is NOT the production key and every address is on loopback. A `launch`
 * root is the same with no link at all: what CI launches once the release build carries a real
 * link, because a build with a link never runs on a runner (`assertNoUpgradeLink`).
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
 * Where a notice is read from: the app's own default relays, the network's first (a test pins them
 * to `packages/renderer/src/settings/defaults.ts`). The maintainer took `relay.damus.io` and
 * `nos.lol` out of the client defaults, so no install dials them for this either. A release notice
 * must be published to these.
 */
export const RELEASE_NOTICE_RELAYS: readonly string[] = [
  'wss://relay.nutflix.xyz',
  'wss://relay.primal.net',
  'wss://relay.ditto.pub',
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

/** Throws unless `root` is a throwaway root with no link: a build of it starts no updater. */
export function assertLaunchRoot(root: TrustRoot): void {
  if (root.channel !== 'launch') throw new Error('a launch build needs the launch channel');
  if (root.pubkey === RELEASE_PUBKEY)
    throw new Error('a launch build never uses the production key');
  if (root.upgrade !== null) throw new Error('a launch build has no upgrade link');
}

/** What `test-build` accepts: a `test` root or a `launch` root, each with its own checks. */
export function throwawayRootFromText(text: string): TrustRoot {
  const root = parseTrustRoot(JSON.parse(text));
  if (root.channel === 'launch') assertLaunchRoot(root);
  else assertTestRoot(root);
  return root;
}

/** The one root a bundle holds; throws on none, or on two that differ. */
export function bakedRootIn(bundle: string): TrustRoot {
  const found = new Set(bundle.match(BAKED_PATTERN) ?? []);
  if (found.size !== 1) throw new Error(`the bundle holds ${String(found.size)} update roots`);
  const [only] = found;
  return decodeBakedRoot(only ?? '');
}

/**
 * Throws if this bundle would start an updater. CI launches packaged builds on GitHub runners, and
 * an updater joins the public DHT at launch, which a runner must never do.
 */
export function assertNoUpgradeLink(bundle: string): void {
  if (bakedRootIn(bundle).upgrade !== null)
    throw new Error(
      'this build has an upgrade link, so launching it would join the public DHT from this runner',
    );
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
  else if (baked.channel === 'launch') assertLaunchRoot(baked);
  else assertTestRoot(baked);
}
