/**
 * What a signature on a release package may say. A signed package is CI's package plus signatures
 * (`signing.ts`), and this pins the signatures themselves: who signed, which flags, which
 * entitlements. Every value is a reviewed constant: nothing at run time can widen it.
 *
 *   - macOS: the Apple Team ID (`null` until the owner has an Apple Developer account; while it is,
 *     only an ad-hoc signature is accepted), the hardened runtime on every executable, and exactly
 *     the entitlements below, per binary. `packaging/entitlements.mac.plist` is the file to sign
 *     the entitled binaries with; a test holds the two together.
 *   - Windows: the signing certificate (`null` until the owner has one; while it is, a signed
 *     `.msix` is refused).
 *
 * The CI proofs sign with identities of their own. They build a policy for that in their own code;
 * the release tool's commands only ever use `productionSigningPolicy()`.
 */
import {
  CS_ADHOC,
  CS_RUNTIME,
  MH_EXECUTE,
  type CodeSignature,
  type Entitlements,
} from './binary.ts';
import { refuse } from './guards.ts';

/** The owner's Apple Team ID, once there is one. */
export const APPLE_TEAM_ID: string | null = null;

/** The owner's Windows code-signing certificate, once there is one: its SHA-256, subject, issuer. */
export const WINDOWS_SIGNER: WindowsSigner | null = null;

export interface WindowsSigner {
  /** SHA-256 of the certificate, as `X509Certificate.fingerprint256` prints it. */
  readonly sha256: string;
  readonly subject: string;
  readonly issuer: string;
}

/** Flags every main executable's signature must carry: the hardened runtime. */
export const REQUIRED_EXECUTABLE_FLAGS = CS_RUNTIME;

const JIT: Readonly<Record<string, boolean>> = { 'com.apple.security.cs.allow-jit': true };

/**
 * The entitlements each signed binary carries, by its path in the bundle. V8 needs JIT in the app,
 * its helpers and the Bare runtime that runs the worker. Every other binary carries none.
 */
export const MAC_ENTITLEMENTS: readonly {
  readonly path: RegExp;
  readonly entitlements: Readonly<Record<string, boolean>>;
}[] = [
  { path: /^Contents\/MacOS\/Nutflix$/, entitlements: JIT },
  {
    path: /^Contents\/Frameworks\/Nutflix Helper(?: \((?:GPU|Plugin|Renderer)\))?\.app\/Contents\/MacOS\/Nutflix Helper(?: \((?:GPU|Plugin|Renderer)\))?$/,
    entitlements: JIT,
  },
  {
    path: /^Contents\/Resources\/app\/node_modules\/bare-sidecar\/prebuilds\/darwin-(?:arm64|x64)\/bare$/,
    entitlements: JIT,
  },
];

export interface SigningPolicy {
  readonly label: string;
  /** `null`: ad-hoc signatures only. */
  readonly appleTeamId: string | null;
  /** `null`: no signed `.msix` is accepted. */
  readonly windowsSigner: WindowsSigner | null;
}

export const productionSigningPolicy = (): SigningPolicy =>
  assertSigningPolicy({
    label: 'production',
    appleTeamId: APPLE_TEAM_ID,
    windowsSigner: WINDOWS_SIGNER,
  });

/** A certificate's SHA-256 as hex digits only, however it is spelled (`AB:CD…` or `abcd…`). */
export const fingerprintOf = (sha256: string): string =>
  sha256.replace(/[^0-9a-f]/gi, '').toUpperCase();

/**
 * Refuses a policy that pins something malformed, rather than one that would quietly accept too
 * much: an empty Team ID would match a signature that names an empty team.
 */
export function assertSigningPolicy(p: SigningPolicy): SigningPolicy {
  if (p.appleTeamId !== null && !/^[A-Z0-9]{10}$/.test(p.appleTeamId))
    refuse(`the pinned Apple Team ID ${JSON.stringify(p.appleTeamId)} is not one`);
  const w = p.windowsSigner;
  if (
    w !== null &&
    (!/^[0-9A-F]{64}$/.test(fingerprintOf(w.sha256)) ||
      !/^[0-9a-f:]+$/i.test(w.sha256) ||
      w.subject.trim() === '' ||
      w.issuer.trim() === '')
  )
    refuse('the pinned Windows certificate is not a SHA-256, a subject and an issuer');
  return p;
}

export function expectedEntitlements(path: string): Entitlements {
  const rule = MAC_ENTITLEMENTS.find((r) => r.path.test(path));
  return new Map(Object.entries(rule?.entitlements ?? {}));
}

const show = (e: Entitlements): string =>
  e.size === 0 ? 'none' : [...e].map(([k, v]) => `${k}=${String(v)}`).join(', ');

/** Throws unless the signature of the binary at `path` is one this policy accepts. */
export function assertMacSignature(
  path: string,
  fileType: number,
  sig: CodeSignature | null,
  policy: SigningPolicy,
): void {
  if (sig === null) return refuse(`${path} is not signed`);
  if (policy.appleTeamId === null) {
    if ((sig.flags & CS_ADHOC) === 0 || sig.identity || sig.teamId !== null)
      refuse(
        `${path} is signed by ${sig.teamId ?? 'an identity'}: with no Apple Team ID pinned, only an ad-hoc signature is accepted`,
      );
  } else if (sig.teamId !== policy.appleTeamId || !sig.identity || (sig.flags & CS_ADHOC) !== 0)
    refuse(`${path} is signed by ${sig.teamId ?? 'no team'}, not Team ID ${policy.appleTeamId}`);
  if (
    fileType === MH_EXECUTE &&
    (sig.flags & REQUIRED_EXECUTABLE_FLAGS) !== REQUIRED_EXECUTABLE_FLAGS
  )
    refuse(`${path} is not signed with the hardened runtime`);
  const want = expectedEntitlements(path);
  const got = sig.entitlements;
  if (got.size !== want.size || [...want].some(([k, v]) => got.get(k) !== v))
    refuse(`${path} has the entitlements ${show(got)}, not ${show(want)}`);
}
