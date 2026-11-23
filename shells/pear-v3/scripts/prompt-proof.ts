/**
 * Runs main's prompt window in real Electron (`prompt-proof-app.ts` says what it checks). It bundles
 * the real window code, the real preload and the real page into a temporary directory and starts
 * Electron on them. Needs a display (`xvfb-run`) and the Electron binary.
 *
 *   node shells/pear-v3/scripts/prompt-proof.ts
 *
 * The exit status is Electron's. CI only: tests never run on a development machine.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const shell = join(here, '..');
const out = mkdtempSync(join(tmpdir(), 'nutflix-prompt-proof-'));

let status: number;
try {
  await build({
    entryPoints: {
      main: join(here, 'prompt-proof-app.ts'),
      'proof-preload': join(here, 'prompt-proof-preload.ts'),
      'prompt-preload': join(shell, 'src', 'prompt', 'prompt-preload.ts'),
    },
    outdir: out,
    outExtension: { '.js': '.cjs' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
    logLevel: 'warning',
  });
  copyFileSync(join(shell, 'src', 'prompt', 'prompt.html'), join(out, 'prompt.html'));

  // The `electron` package's main, under Node, is the path of its binary.
  const electron = createRequire(import.meta.url)('electron') as string;
  const env = { ...process.env };
  delete env['ELECTRON_RUN_AS_NODE'];
  const r = spawnSync(electron, [join(out, 'main.cjs')], {
    stdio: 'inherit',
    timeout: 120_000,
    env,
  });
  if (r.error !== undefined) console.error(`Electron did not run: ${r.error.message}`);
  status = r.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
process.exit(status);
