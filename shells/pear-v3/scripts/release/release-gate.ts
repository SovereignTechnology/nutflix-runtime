/**
 * What a release must have before it is committed or announced, beyond its bytes:
 *
 *   - macOS: each package signed by the owner (CI's own build has no hardened runtime, and it never
 *     ships), and an Apple Team ID pinned, unless a reviewed change chose to release macOS ad hoc
 *     (`ALLOW_AD_HOC_MACOS_RELEASE`);
 *   - Windows: each package signed by the owner, and a code-signing certificate pinned
 *     (`WINDOWS_SIGNER`). There is no unsigned way out: CI's `.msix` is unsigned, and an unsigned
 *     `.msix` does not install for users.
 *
 * `multisig commit` and `notice-draft` hold a release to it, and each signer's `verify-request`
 * holds a request to it by the targets they name with `--signed-target`.
 */
import type { ReleaseFile, ReleaseRow } from './assemble.ts';
import { refuse } from './guards.ts';
import type { SigningPolicy } from './signing-policy.ts';
import { RELEASE_TARGETS } from './targets.ts';

/** The refusal when no Team ID is pinned and ad hoc was not chosen. `outcome` says what did not happen. */
export const noTeamIdRefusal = (outcome: string): string =>
  `macOS is not released ad hoc: no Apple Team ID is pinned. The owner either pins APPLE_TEAM_ID in shells/pear-v3/scripts/release/signing-policy.ts (docs/release.md, "Once", step 6), or decides, in a reviewed change, to release macOS ad hoc by setting ALLOW_AD_HOC_MACOS_RELEASE to true there (docs/release.md, "Releasing macOS ad hoc"). ${outcome}`;

/** The refusal when a macOS target ships as CI built it. */
export const unsignedMacRefusal = (target: string, file: string, outcome: string): string =>
  `${target} has no signed package in ${file}: CI's own macOS build has no hardened runtime, and it never ships. The owner signs a copy of it and records it with \`release record-signed --out <release folder> --target ${target} --signed <the signed Nutflix.app>\` (docs/release.md, steps 5 and 6). ${outcome}`;

/** The refusal when no Windows certificate is pinned. There is no unsigned way out. */
export const noWindowsSignerRefusal = (outcome: string): string =>
  `Windows is not released unsigned: no Windows code-signing certificate is pinned, and an unsigned .msix does not install for users. The owner pins WINDOWS_SIGNER in shells/pear-v3/scripts/release/signing-policy.ts (docs/release.md, "Once", step 6, and "Windows is never released unsigned"). ${outcome}`;

/** The refusal when a Windows target ships as CI built it. */
export const unsignedWindowsRefusal = (target: string, file: string, outcome: string): string =>
  `${target} has no signed package in ${file}: CI's own .msix is unsigned, and it does not install for users. The owner signs a copy of it with the pinned certificate and records it with \`release record-signed --out <release folder> --target ${target} --signed <the signed Nutflix.msix>\` (docs/release.md, steps 5 and 6). ${outcome}`;

/** A signer's refusal when a Windows target is not named as signed. */
export const unnamedWindowsRefusal = (target: string, outcome: string): string =>
  `${target} is not named with --signed-target: a request that ships CI's own unsigned .msix, which does not install for users, is never signed. ${outcome}`;

/** The rules on the policy itself, before any target is looked at. */
function assertPolicyReleases(policy: SigningPolicy, outcome: string): void {
  if (policy.appleTeamId === null && !policy.allowAdHocMacosRelease)
    refuse(noTeamIdRefusal(outcome));
  if (policy.windowsSigner === null) refuse(noWindowsSignerRefusal(outcome));
}

/**
 * What a signer checks before anything else: the same rules, by the targets they name as signed.
 * A macOS or Windows target not named is CI's own build, and it never ships.
 */
export function assertSignable(
  signedTargets: ReadonlySet<string>,
  policy: SigningPolicy,
  outcome: string,
): void {
  assertPolicyReleases(policy, outcome);
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'darwin'))
    if (!signedTargets.has(t.name))
      refuse(
        `${t.name} is not named with --signed-target: a request that ships CI's own macOS build, which has no hardened runtime, is never signed. ${outcome}`,
      );
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'win32'))
    if (!signedTargets.has(t.name)) refuse(unnamedWindowsRefusal(t.name, outcome));
}

/**
 * Whether a row ships a package the owner signed: a `signed` entry naming its package and digest,
 * which is what `shippedApp` and `shippedDigest` take instead of CI's. Anything else, a `null`
 * included, ships CI's own package, and counts as not signed.
 */
const isSigned = (row: ReleaseRow | undefined): boolean => {
  const s: unknown = row?.signed;
  if (typeof s !== 'object' || s === null) return false;
  const { app, digest } = s as Record<string, unknown>;
  return typeof app === 'string' && app !== '' && typeof digest === 'string' && digest !== '';
};

/** Throws unless `release` (read from `file`) may be committed or announced under `policy`. */
export function assertReleasable(
  release: ReleaseFile,
  file: string,
  policy: SigningPolicy,
  outcome: string,
): void {
  assertPolicyReleases(policy, outcome);
  const signed = (name: string): boolean =>
    isSigned(release.targets.find((r) => r.target === name));
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'darwin'))
    if (!signed(t.name)) refuse(unsignedMacRefusal(t.name, file, outcome));
  for (const t of RELEASE_TARGETS.filter((x) => x.platform === 'win32'))
    if (!signed(t.name)) refuse(unsignedWindowsRefusal(t.name, file, outcome));
}
