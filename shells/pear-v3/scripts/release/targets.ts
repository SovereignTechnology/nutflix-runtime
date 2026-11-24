/**
 * The five targets of a release (ADR 0001 amendment, item 5), each with the two names it goes by:
 * the file in the deployment (`by-arch/<target>/app/Nutflix.AppImage`) and the name a release notice
 * gives it (`Nutflix-linux-x64.AppImage`, the update gate's own `artifactName`).
 */
import { APP, TARGETS, type Arch, type Platform } from '../../packaging/identity.ts';
import { artifactName } from '../../src/update/gate.ts';
import { appFileName, type TargetName } from '../pear-ci/pins.ts';

export interface ReleaseTarget {
  readonly name: TargetName;
  readonly platform: Platform;
  readonly arch: Arch;
  /** `Nutflix.AppImage`, `Nutflix.app` or `Nutflix.msix`. */
  readonly file: string;
  /** `Nutflix-<target>.<ext>`: what the notice calls it. */
  readonly noticeName: string;
}

export const RELEASE_TARGETS: readonly ReleaseTarget[] = TARGETS.map((t) => {
  const name = `${t.platform}-${t.arch}` as TargetName;
  const file = appFileName(t.platform, APP.productName);
  return { name, platform: t.platform, arch: t.arch, file, noticeName: artifactName(name, file) };
});

/** `by-arch/<target>/app/<file>`, with `/`. */
export const deploymentEntry = (t: ReleaseTarget): string => `by-arch/${t.name}/app/${t.file}`;
