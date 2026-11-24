/**
 * What a signer checks before signing. `pear multisig sign` shows a signer nothing about what they
 * are approving: it asks for a password and prints a response. So a coordinator could put anything
 * in front of a quorum. This check does not take the coordinator's word for anything:
 *
 *   1. what CI built comes from GitHub, for a run on `main` (`provenance.ts`);
 *   2. the drive comes from peers, at the exact version, and its entries are hashed here;
 *   3. each must be CI's package, or CI's package with signatures added (`signing.ts`), for a target
 *      the signer names as signed;
 *   4. Pear confirms the request is for that drive at that exact length, onto the production link,
 *      and the version fetched has the same db and blobs tree hashes the request writes: all in one
 *      Pear home of the check's own, so every answer comes from the same local cores.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deploymentPackageJson, listFiles } from '../pear-ci/deployment.ts';
import type { TargetName } from '../pear-ci/pins.ts';
import { field, lastRecord, type PearRecord } from '../pear-ci/records.ts';
import {
  planDump,
  planInfo,
  planMultisigLink,
  planProvisionDryRun,
  planVerifyRequest,
} from './commands.ts';
import { digestOf } from './digest.ts';
import { linkKeyOf, refuse } from './guards.ts';
import { compareSigned } from './signing.ts';
import type { SigningPolicy } from './signing-policy.ts';
import { deploymentEntry, type ReleaseTarget } from './targets.ts';

export interface CiEntry {
  readonly target: ReleaseTarget;
  /** The package CI built, unpacked here. */
  readonly app: string;
  readonly digest: string;
}

export interface DriveRow {
  readonly target: string;
  readonly digest: string;
  readonly how: 'exact' | 'signed';
}

/**
 * Refuses unless the drive fetched into `dir` holds these packages and nothing else. A target in
 * `signed` may differ from CI's package by its signatures, and by nothing else.
 */
export async function compareDrive(
  dir: string,
  version: string,
  ci: readonly CiEntry[],
  signed: ReadonlySet<TargetName> = new Set(),
  policy?: SigningPolicy,
): Promise<DriveRow[]> {
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return refuse('the drive has no package.json');
  if (readFileSync(manifest, 'utf8') !== deploymentPackageJson({ version }))
    return refuse(`the drive's package.json is not the one for version ${version}`);
  const entries = ci.map((c) => deploymentEntry(c.target));
  for (const f of await listFiles(dir))
    if (f !== 'package.json' && !entries.some((e) => f === e || f.startsWith(`${e}/`)))
      return refuse(`the drive holds ${f}, which CI did not build`);
  const rows: DriveRow[] = [];
  for (const c of ci) {
    const entry = join(dir, ...deploymentEntry(c.target).split('/'));
    if (!existsSync(entry)) return refuse(`the drive has no ${deploymentEntry(c.target)}`);
    const digest = await digestOf(entry);
    if (digest === c.digest) {
      rows.push({ target: c.target.name, digest, how: 'exact' });
      continue;
    }
    if (!signed.has(c.target.name))
      return refuse(
        `${c.target.name}: the drive's entry is not what CI built (${digest}, CI built ${c.digest})`,
      );
    await compareSigned(c.target, c.app, entry, policy);
    rows.push({ target: c.target.name, digest, how: 'signed' });
  }
  return rows;
}

/** A core at one version: its length and its tree hash, as Pear prints them (z32). */
export interface CoreVersion {
  readonly length: number;
  readonly treeHash: string;
}

export interface RequestedVersion {
  readonly db: CoreVersion;
  readonly blobs: CoreVersion;
}

const coreVersion = (x: unknown, hashKey: 'treeHash' | 'hash', what: string): CoreVersion => {
  const v = x as { length?: unknown; treeHash?: unknown; hash?: unknown } | undefined;
  const length = v?.length;
  const treeHash = v?.[hashKey];
  if (typeof length !== 'number' || typeof treeHash !== 'string' || treeHash === '')
    return refuse(`Pear reported no ${what}`);
  return { length, treeHash };
};

/**
 * Refuses unless Pear's dry run of the request (`pear multisig verify` with no responses) says it
 * writes this exact version onto `production`. Returns the db and blobs versions the request writes.
 */
export function assertRequestBinds(
  data: Readonly<Record<string, unknown>> | undefined,
  production: string,
  verlink: string,
): RequestedVersion {
  const d = data as
    | { dstKey?: unknown; result?: { db?: { batch?: unknown }; blobs?: { batch?: unknown } } }
    | undefined;
  if (d?.dstKey !== linkKeyOf(production))
    return refuse(
      `the request writes to ${String(d?.dstKey)}, not the production link ${production}`,
    );
  const db = coreVersion(d.result?.db?.batch, 'treeHash', 'tree hash for the request');
  const want = Number(verlink.slice('pear://'.length).split('.')[1]);
  if (db.length !== want)
    return refuse(
      `the request releases length ${String(db.length)} of the drive, not the ${String(want)} checked`,
    );
  return { db, blobs: coreVersion(d.result?.blobs?.batch, 'treeHash', 'blobs for the request') };
}

/**
 * Refuses unless the cores the version was fetched from are the ones the request writes.
 * `pear provision --dry-run` of the verlink reports the source's db and blobs cores as this Pear
 * home holds them: their length and tree hash now, not at the verlink (Pear 3.7.0's checkout shares
 * the cores). So both must equal the request's: then the local cores are exactly at the version the
 * request writes, and what `pear dump` read from them is what is signed. A core that grew since
 * fails this; one that forked fails the fork check after. The db alone would not do: a db entry
 * names a blob, it does not hash it.
 */
export function assertFetchedIsRequested(
  diffed: Readonly<Record<string, unknown>> | undefined,
  requested: RequestedVersion,
): void {
  const source = diffed?.['source'] as { core?: unknown; blobs?: unknown } | undefined;
  const db = coreVersion(source?.core, 'hash', 'db core for the version fetched');
  const blobs = coreVersion(source?.blobs, 'hash', 'blobs core for the version fetched');
  if (db.length !== requested.db.length || db.treeHash !== requested.db.treeHash)
    refuse('the db core fetched is not the one the request writes');
  if (blobs.length !== requested.blobs.length || blobs.treeHash !== requested.blobs.treeHash)
    refuse('the blobs core fetched is not the one the request writes: its file bytes may differ');
}

/** The drive's fork, and its blobs' fork, from `pear info`; both must be the verlink's fork. */
export function assertFork(
  info: Readonly<Record<string, unknown>> | undefined,
  verlink: string,
): void {
  const fork = Number(verlink.slice('pear://'.length).split('.')[0]);
  const blobs = info?.['blobs'] as { fork?: unknown } | null | undefined;
  if (info?.['fork'] !== fork || blobs?.fork !== fork)
    refuse(
      `the drive is at fork ${String(info?.['fork'])} (blobs ${String(blobs?.fork)}), not the verlink's ${String(fork)}`,
    );
}

/** Runs `pear <args>` in the check's own Pear home; refuses unless it succeeds. */
export type PearInOneHome = (args: readonly string[], what: string) => Promise<PearRecord[]>;

const dataOf = (
  records: readonly PearRecord[],
  tag: string,
): Readonly<Record<string, unknown>> | undefined => lastRecord(records, tag)?.data;

/**
 * Step 4, in order, every call through `pear`, which runs them all in one Pear home: the config
 * derives the production link; the drive is at the verlink's fork; the request writes exactly the
 * verlink onto production; the drive is fetched at the verlink into `dumpDir`; the db and blobs
 * cores it was fetched from are, by length and tree hash, the ones the request writes; and the
 * request and the fork are the same afterwards.
 */
export async function checkRequestInOneHome(
  pear: PearInOneHome,
  o: {
    readonly config: string;
    readonly verlink: string;
    readonly request: string;
    readonly production: string;
    readonly dumpDir: string;
  },
): Promise<CheckedRequest> {
  const source = `pear://${linkKeyOf(o.verlink)}`;
  const derived = field(
    lastRecord(
      await pear(planMultisigLink({ config: o.config }).args, 'pear multisig link'),
      'final',
    ),
    'link',
  );
  if (derived !== o.production)
    return refuse(
      `this config derives ${String(derived)}, not the production link ${o.production}`,
    );
  const info = planInfo({ link: source }).args;
  const ask = planVerifyRequest({ config: o.config, source, request: o.request }).args;
  assertFork(dataOf(await pear(info, 'pear info'), 'info'), o.verlink);
  const before = assertRequestBinds(
    dataOf(await pear(ask, 'Pear'), 'final'),
    o.production,
    o.verlink,
  );
  await pear(planDump({ verlink: o.verlink, dir: o.dumpDir }).args, `fetching ${o.verlink}`);
  const fetched = planProvisionDryRun({
    source: o.verlink,
    production: `pear://0.0.${linkKeyOf(o.production)}`,
  }).args;
  const cores = dataOf(await pear(fetched, 'pear provision --dry-run'), 'diffed');
  assertFetchedIsRequested(cores, before);
  const after = assertRequestBinds(
    dataOf(await pear(ask, 'Pear'), 'final'),
    o.production,
    o.verlink,
  );
  if (JSON.stringify(after) !== JSON.stringify(before))
    return refuse('the drive changed during the check: do not sign');
  assertFork(dataOf(await pear(info, 'pear info'), 'info'), o.verlink);
  return { requested: before, cores };
}

export interface CheckedRequest {
  /** The version the request writes. */
  readonly requested: RequestedVersion;
  /** What `pear provision --dry-run` reported of the cores held, as it reported it. */
  readonly cores: Readonly<Record<string, unknown>> | undefined;
}
