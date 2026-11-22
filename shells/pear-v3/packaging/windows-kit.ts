/**
 * The newest Windows SDK version installed (`10.0.26100.0` and the like), for the MSIX maker's
 * `windowsKitVersion`, as Holepunch's template finds it (`forge.config.js`). `undefined` off
 * Windows or when no SDK is there.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function windowsKitVersion(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const programFiles = env['PROGRAMFILES(X86)'] ?? env['PROGRAMFILES'];
  if (programFiles === undefined) return undefined;
  const kits = join(programFiles, 'Windows Kits');
  try {
    for (const kit of readdirSync(kits).sort().reverse()) {
      const bin = join(kits, kit, 'bin');
      if (!existsSync(bin)) continue;
      const version = readdirSync(bin)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort((a, b) => cmp(a, b))
        .pop();
      if (version !== undefined) return version;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Numeric, part by part (a plain string sort puts 10.0.9 after 10.0.19041). */
function cmp(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** `makeappx.exe` of the newest installed SDK, for `x64`. */
export function makeAppx(env: NodeJS.ProcessEnv = process.env): string {
  const v = windowsKitVersion(env);
  const programFiles = env['PROGRAMFILES(X86)'] ?? env['PROGRAMFILES'];
  if (v === undefined || programFiles === undefined) throw new Error('no Windows SDK found');
  return join(programFiles, 'Windows Kits', '10', 'bin', v, 'x64', 'makeappx.exe');
}
