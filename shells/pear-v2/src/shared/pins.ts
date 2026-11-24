/**
 * What this shell is pinned to (ADR 0001, amendment items 1 and 6; `docs/spikes/S1-pear-v2-pin.md`).
 *
 * The runtime updates itself from whatever key it was installed from, and neither `--no-updates`
 * nor anything an app can do stops that. The one hold S1 found is a release line nobody appends
 * to, so the app refuses to start on any platform but the exact key, fork and length its build
 * names. `RELEASE_LINE` is that line. It is `null` until the owner creates it: creating and seeding
 * a key is publishing, and until then `scripts/stage.ts` makes test builds only.
 */

/** Pear v2.6.5 as Holepunch published it: what a SovTech release line must be a copy of. */
export const PEAR_V2 = Object.freeze({
  version: '2.6.5',
  bare: '1.24.3',
  electron: '33.2.1',
  chromiumMajor: 130,
  upstream: Object.freeze({
    key: 'pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o',
    fork: 0,
    length: 3243,
  }),
  /**
   * The Electron UI drive `pear-electron` 1.7.28 names, on Holepunch's key: a versioned link, which
   * fixes a fork and length, not the bytes (its key holder can sign another tree at that length).
   */
  uiAsset: 'pear://0.940.cktxzetiwt6un3ado5kgqedge6ya4nfazjckzq76zcapefwxakdy',
});

/**
 * The Electron UI drive this build runs, as the staged `pear-electron` names it. It is still
 * Holepunch's (`PEAR_V2.uiAsset`), and no release may run that (ADR 0001 amendment, item 1):
 * re-homing it on a SovTech key, or checking its bytes when it runs, is the owner's step. Until this
 * names another key, `scripts/stage.ts` makes test builds only.
 */
export const UI_DRIVE: string = PEAR_V2.uiAsset;

/** A platform drive at one exact version. */
export interface ReleaseLine {
  /** The drive's key, z-base-32. */
  readonly key: string;
  readonly fork: number;
  readonly length: number;
}

/** The SovTech release line of Pear v2.6.5. `null`: not created yet (the owner's step). */
export const RELEASE_LINE: ReleaseLine | null = null;

const Z32_KEY = /^[ybndrfg8ejkmcpqxot1uwisza345h769]{52}$/;

export function isReleaseLine(x: unknown): x is ReleaseLine {
  if (typeof x !== 'object' || x === null) return false;
  const l = x as Record<string, unknown>;
  return (
    typeof l['key'] === 'string' &&
    Z32_KEY.test(l['key']) &&
    Number.isSafeInteger(l['fork']) &&
    (l['fork'] as number) >= 0 &&
    Number.isSafeInteger(l['length']) &&
    (l['length'] as number) > 0
  );
}

/** What `Pear.versions()` reports, as far as this check reads it. */
export interface RuntimeVersions {
  readonly platform?: {
    readonly key?: unknown;
    readonly fork?: unknown;
    readonly length?: unknown;
  };
  readonly runtimes?: { readonly bare?: unknown; readonly pear?: unknown };
}

/**
 * Why this runtime is not the one the build is pinned to, or `null` when it is. `key` is the
 * platform key as the runtime reports it, already normalised to z-base-32 by the caller.
 */
export function runtimeMismatch(
  v: RuntimeVersions,
  key: string | null,
  line: ReleaseLine,
): string | null {
  if (v.runtimes?.pear !== PEAR_V2.version) return 'the Pear version is not the pinned one';
  if (v.runtimes.bare !== PEAR_V2.bare) return 'the Bare version is not the pinned one';
  if (key !== line.key) return 'the platform key is not this build’s release line';
  if (v.platform?.fork !== line.fork || v.platform.length !== line.length)
    return 'the platform is not at the pinned version of its release line';
  return null;
}
