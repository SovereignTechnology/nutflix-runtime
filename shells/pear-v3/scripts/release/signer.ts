/**
 * What a signer checks before signing. `pear multisig sign` shows a signer nothing about what they
 * are approving: it asks for a password and prints a response. So a coordinator could put anything
 * in front of a quorum. This check does not take the coordinator's word for anything:
 *
 *   1. what CI built comes from GitHub, for a run on `main` (`provenance.ts`);
 *   2. the drive comes from peers, at the exact version, and its entries are hashed here;
 *   3. each must be CI's package, or CI's package with signatures added (`signing.ts`), for a target
 *      the signer names as signed;
 *   4. Pear confirms the request is for that drive at that exact length, onto the production link.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { deploymentPackageJson, listFiles } from '../pear-ci/deployment.ts';
import type { TargetName } from '../pear-ci/pins.ts';
import { digestOf } from './digest.ts';
import { linkKeyOf, refuse } from './guards.ts';
import { compareSigned } from './signing.ts';
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
    await compareSigned(c.target, c.app, entry);
    rows.push({ target: c.target.name, digest, how: 'signed' });
  }
  return rows;
}

/**
 * Refuses unless Pear's dry run says the request writes this exact version onto `production`.
 * Returns the tree hash Pear checked the request against: the check is made before and after the
 * drive is fetched, and the two must agree, so that a writer cannot show one fork to the fetch and
 * another to the request.
 */
export function assertRequestBinds(
  data: Readonly<Record<string, unknown>> | undefined,
  production: string,
  verlink: string,
): string {
  const d = data as
    | {
        dstKey?: unknown;
        result?: { db?: { batch?: { length?: unknown; treeHash?: unknown } } };
      }
    | undefined;
  if (d?.dstKey !== linkKeyOf(production))
    return refuse(
      `the request writes to ${String(d?.dstKey)}, not the production link ${production}`,
    );
  const batch = d.result?.db?.batch;
  const want = Number(verlink.slice('pear://'.length).split('.')[1]);
  if (batch?.length !== want)
    return refuse(
      `the request releases length ${String(batch?.length)} of the drive, not the ${String(want)} checked`,
    );
  if (typeof batch.treeHash !== 'string' || batch.treeHash === '')
    return refuse('Pear reported no tree hash for the request');
  return batch.treeHash;
}
