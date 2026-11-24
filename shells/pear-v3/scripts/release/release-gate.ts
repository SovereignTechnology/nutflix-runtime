/**
 * What a release must have before it is committed or announced, beyond its bytes: each macOS
 * package signed by the owner (CI's own build has no hardened runtime, and it never ships), and an
 * Apple Team ID pinned, unless a reviewed change chose to release macOS ad hoc
 * (`ALLOW_AD_HOC_MACOS_RELEASE`). `multisig commit` and `notice-draft` hold a release to it.
 */
import type { ReleaseFile } from './assemble.ts';
import { refuse } from './guards.ts';
import type { SigningPolicy } from './signing-policy.ts';
import { RELEASE_TARGETS } from './targets.ts';

/** The refusal when no Team ID is pinned and ad hoc was not chosen. `outcome` says what did not happen. */
export const noTeamIdRefusal = (outcome: string): string =>
  `macOS is not released ad hoc: no Apple Team ID is pinned. The owner either pins APPLE_TEAM_ID in shells/pear-v3/scripts/release/signing-policy.ts (docs/release.md, "Once", step 6), or decides, in a reviewed change, to release macOS ad hoc by setting ALLOW_AD_HOC_MACOS_RELEASE to true there (docs/release.md, "Releasing macOS ad hoc"). ${outcome}`;

/** The refusal when a macOS target ships as CI built it. */
export const unsignedMacRefusal = (target: string, file: string, outcome: string): string =>
  `${target} has no signed package in ${file}: CI's own macOS build has no hardened runtime, and it never ships. The owner signs a copy of it and records it with \`release record-signed --out <release folder> --target ${target} --signed <the signed Nutflix.app>\` (docs/release.md, steps 5 and 6). ${outcome}`;

/**
 * What a signer checks before anything else: the same rule, by the targets they name as signed.
 * A macOS target not named is CI's own build, and it never ships.
 */
export function assertSignable(
  signedTargets: ReadonlySet<string>,
  policy: SigningPolicy,
  outcome: string,
): void {
  if (policy.appleTeamId === null && !policy.allowAdHocMacosRelease)
    refuse(noTeamIdRefusal(outcome));
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'darwin'))
    if (!signedTargets.has(t.name))
      refuse(
        `${t.name} is not named with --signed-target: a request that ships CI's own macOS build, which has no hardened runtime, is never signed. ${outcome}`,
      );
}

/** Throws unless `release` (read from `file`) may be committed or announced under `policy`. */
export function assertReleasable(
  release: ReleaseFile,
  file: string,
  policy: SigningPolicy,
  outcome: string,
): void {
  if (policy.appleTeamId === null && !policy.allowAdHocMacosRelease)
    refuse(noTeamIdRefusal(outcome));
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'darwin')) {
    const row = release.targets.find((r) => r.target === t.name);
    if (row?.signed === undefined) refuse(unsignedMacRefusal(t.name, file, outcome));
  }
}
