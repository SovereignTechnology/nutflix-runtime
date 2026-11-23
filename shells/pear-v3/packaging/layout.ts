/**
 * What a finished package must look like, checked on every packaged output before it counts
 * (Forge `postPackage`), beside the fuse read-back. After nutflix-pear's `layout.ts`, for an
 * UNPACKED app (`resources/app/`, no asar; see `fuses.ts`):
 *
 *   - `resources/app/` exists and there is no `resources/app.asar`;
 *   - main, the preload, the renderer's entry page, the worker's entry, pear-runtime and
 *     bare-sidecar are there as REAL files: never a symlink, nor under a symlinked directory,
 *     either of which could lead Bare out of the app's own directory;
 *   - bare-sidecar's runtime for this target is a regular, executable file;
 *   - no other platform's `bare` runtime was shipped.
 */
import { accessSync, constants, existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { STAGED, bareBinary } from './identity.ts';

export function resourcesDir(outputDir: string, platform: string, productName: string): string {
  return platform === 'darwin' || platform === 'mas'
    ? join(outputDir, `${productName}.app`, 'Contents', 'Resources')
    : join(outputDir, 'resources');
}

export function layoutProblems(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
): string[] {
  const res = resourcesDir(outputDir, platform, productName);
  const app = join(res, 'app');
  const problems: string[] = [];
  if (existsSync(join(res, 'app.asar')))
    problems.push('resources/app.asar exists: this app ships unpacked');
  if (!existsSync(app)) return [...problems, 'resources/app is missing'];
  const real = (rel: string, mustBeFile: boolean): void => {
    const parts = rel.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      let st: ReturnType<typeof lstatSync>;
      try {
        st = lstatSync(join(app, p));
      } catch {
        problems.push(`${rel} is missing`);
        return;
      }
      if (st.isSymbolicLink()) {
        problems.push(`${p} is a symlink; it must be a real file or directory`);
        return;
      }
      if (i === parts.length && mustBeFile && !st.isFile()) problems.push(`${rel} is not a file`);
    }
  };
  real(STAGED.main, true);
  real(STAGED.preload, true);
  real(STAGED.updateWorker, true);
  real(STAGED.rendererIndex, true);
  real(STAGED.workerEntry, true);
  real(STAGED.pearRuntime, true);
  const bin = bareBinary(platform, arch);
  real(bin, true);
  if (platform !== 'win32' && process.platform !== 'win32') {
    try {
      accessSync(join(app, bin), constants.X_OK);
    } catch {
      problems.push(`${bin} is not executable`);
    }
  }
  const prebuilds = join(app, STAGED.bareSidecar, 'prebuilds');
  if (existsSync(prebuilds)) {
    const extra = readdirSync(prebuilds).filter(
      (d) => d !== `${platform}-${arch}` && !(platform === 'darwin' && d === 'darwin-universal'),
    );
    if (extra.length > 0)
      problems.push(`other platforms' Bare runtimes shipped: ${extra.join(', ')}`);
  }
  return problems;
}

export function assertLayout(
  outputDir: string,
  platform: string,
  arch: string,
  productName: string,
): void {
  const p = layoutProblems(outputDir, platform, arch, productName);
  if (p.length > 0) throw new Error(`packaged layout wrong in ${outputDir}:\n  ${p.join('\n  ')}`);
}
