/**
 * What the updater process tells main, and what main passes on to the window. A status is a state
 * from a fixed list, a reason from a fixed list, a plain version and a small count: never a path, a
 * link, a key or anything a relay or a peer chose. Main checks every frame with `parseUpdateStatus`
 * before it logs it or sends it to the renderer.
 */

export const UPDATE_STATES = [
  'watching',
  'checking',
  'held',
  'applying',
  'applied',
  'failed',
] as const;
export type UpdateState = (typeof UPDATE_STATES)[number];

export const UPDATE_REASONS = [
  /** No relay answered, so no notice could be read. */
  'relay-unreachable',
  /** A relay answered, and no valid notice was among what it sent. */
  'no-notice',
  /** The newest valid notice is older than one this install has already seen. */
  'stale-notice',
  /** The newest valid notice names another versioned link. */
  'link-mismatch',
  /** The newest valid notice names another version. */
  'version-mismatch',
  /** The newest valid notice lists no artifact for this platform. */
  'no-artifact',
  /** The build's sha256 is not the one the notice names. */
  'hash-mismatch',
  /** The candidate changed between the check and the apply. */
  'changed',
  /** The check itself failed: nothing was applied. */
  'error',
  /** `applyUpdate()` returned and the installed app is not the verified build. */
  'swap-unproved',
  /** The updater reported an error while it fetched (the status stays `watching`). */
  'updater-error',
] as const;
export type UpdateReason = (typeof UPDATE_REASONS)[number];

/** How the swap was proved. `msix-deployed`: Windows accepted the package; CI checks the result. */
export const UPDATE_PROOFS = ['sha256', 'msix-deployed'] as const;
export type UpdateProof = (typeof UPDATE_PROOFS)[number];

export interface UpdateStatus {
  readonly state: UpdateState;
  readonly reason?: UpdateReason;
  /** The candidate's version, when it is a plain `a.b.c`. */
  readonly version?: string;
  /** How many notices were read and refused while deciding. */
  readonly refused?: number;
  readonly proof?: UpdateProof;
}

export const PLAIN_VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;
const MAX_REFUSED = 1000;

const within = <T extends string>(list: readonly T[], x: unknown): x is T =>
  typeof x === 'string' && (list as readonly string[]).includes(x);

/** `x` as a status, or `null`. An unknown field is refused. */
export function parseUpdateStatus(x: unknown): UpdateStatus | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  for (const k of Object.keys(r))
    if (!['state', 'reason', 'version', 'refused', 'proof'].includes(k)) return null;
  const state = r['state'];
  if (!within(UPDATE_STATES, state)) return null;
  const out: {
    state: UpdateState;
    reason?: UpdateReason;
    version?: string;
    refused?: number;
    proof?: UpdateProof;
  } = { state };
  const reason = r['reason'];
  if (reason !== undefined) {
    if (!within(UPDATE_REASONS, reason)) return null;
    out.reason = reason;
  }
  const version = r['version'];
  if (version !== undefined) {
    if (typeof version !== 'string' || !PLAIN_VERSION.test(version)) return null;
    out.version = version;
  }
  const refused = r['refused'];
  if (refused !== undefined) {
    if (
      typeof refused !== 'number' ||
      !Number.isInteger(refused) ||
      refused < 0 ||
      refused > MAX_REFUSED
    )
      return null;
    out.refused = refused;
  }
  const proof = r['proof'];
  if (proof !== undefined) {
    if (!within(UPDATE_PROOFS, proof)) return null;
    out.proof = proof;
  }
  return out;
}

/** What main tells the updater process when it starts it. */
export interface UpdateStart {
  /** The updater's own directory, under the app's user data. */
  readonly dir: string;
  /** This build's version. */
  readonly version: string;
  /** The artifact's file name in the deployment (`Nutflix.AppImage`, `.app`, `.msix`). */
  readonly name: string;
  /** What `applyUpdate()` swaps: the AppImage, the `.app` bundle, or the executable on Windows. */
  readonly app: string;
  /** `<platform>-<arch>`, the deployment's `by-arch` folder. */
  readonly host: string;
}

const HOST = /^(linux|darwin|win32)-(x64|arm64)$/;
const NAME = /^Nutflix\.(AppImage|app|msix)$/;
const MAX_PATH = 4096;

/** `x` as a start message, or `null`. */
export function parseUpdateStart(x: unknown): UpdateStart | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const r = x as Record<string, unknown>;
  const { dir, version, name, app, host } = r;
  if (
    typeof dir !== 'string' ||
    dir.length === 0 ||
    dir.length > MAX_PATH ||
    typeof app !== 'string' ||
    app.length === 0 ||
    app.length > MAX_PATH ||
    typeof version !== 'string' ||
    !PLAIN_VERSION.test(version) ||
    typeof name !== 'string' ||
    !NAME.test(name) ||
    typeof host !== 'string' ||
    !HOST.test(host)
  )
    return null;
  return { dir, version, name, app, host };
}
