/**
 * The Windows half of the install job: an ephemeral certificate that signs the TEST `.msix`, the
 * facts Windows keeps about an installed package, and the path of the `Nutflix.exe` execution
 * alias that makes a packaged app launchable with its output on a pipe.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { APP, MSIX } from '../../packaging/identity.ts';
import { makeAppx } from '../../packaging/windows-kit.ts';

const here = (name: string, scriptsDir: string): string => join(scriptsDir, 'windows', name);

function ps(
  script: string,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
    { encoding: 'utf8', timeout: 180_000 },
  );
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function line(stdout: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(stdout)?.[1]?.trim();
}

export interface TestCert {
  readonly thumbprint: string;
  readonly subject: string;
}

/**
 * A new self-signed code-signing certificate whose subject is the manifest's publisher, trusted on
 * this machine only (Trusted People). Its key is not exportable and is in no file.
 */
export function newTestCert(scriptsDir: string, cerPath: string): TestCert {
  const r = ps(here('test-cert.ps1', scriptsDir), [
    '-Action',
    'new',
    '-Subject',
    MSIX.publisher,
    '-CerPath',
    cerPath,
  ]);
  const thumbprint = line(r.stdout, 'THUMBPRINT');
  const subject = line(r.stdout, 'SUBJECT');
  if (r.status !== 0 || thumbprint === undefined || subject === undefined)
    throw new Error(
      `test-cert.ps1 new: exit ${String(r.status)} ${r.stdout}${r.stderr}`.slice(0, 800),
    );
  if (subject !== MSIX.publisher)
    throw new Error(
      `the certificate's subject is ${subject}, the manifest's publisher is ${MSIX.publisher}`,
    );
  return { thumbprint, subject };
}

export function removeTestCert(scriptsDir: string, thumbprint: string): void {
  ps(here('test-cert.ps1', scriptsDir), ['-Action', 'remove', '-Thumbprint', thumbprint]);
}

/** `signtool.exe` beside the SDK's `makeappx.exe`. */
export function signtool(): string {
  const exe = join(dirname(makeAppx()), 'signtool.exe');
  if (!existsSync(exe)) throw new Error(`no signtool at ${exe}`);
  return exe;
}

/** Signs `msix` in place with the certificate in the current user's store. */
export function signMsix(msix: string, cert: TestCert): string {
  const r = spawnSync(
    signtool(),
    ['sign', '/fd', 'SHA256', '/sha1', cert.thumbprint, '/s', 'My', '/v', msix],
    { encoding: 'utf8' },
  );
  if (r.status !== 0)
    throw new Error(`signtool sign: exit ${String(r.status)} ${r.stdout}${r.stderr}`.slice(-800));
  return r.stdout.trim().split(/\r?\n/).slice(-4).join('\n');
}

export interface PackageFacts {
  readonly Name: string;
  readonly Version: string;
  readonly Publisher: string;
  readonly PackageFamilyName: string;
  readonly PackageFullName: string;
  readonly SignatureKind: string | number;
  readonly Status: string | number;
  readonly InstallLocation: string;
}

export interface PackageInfo {
  readonly package: PackageFacts | null;
  /** Of a running process: its package full name, `NONE`, or a failure word. */
  readonly processPackage?: string;
}

/** What Windows says about the installed package, and about `pid` if given. */
export function packageInfo(scriptsDir: string, pid?: number): PackageInfo {
  const r = ps(here('package-info.ps1', scriptsDir), [
    '-Name',
    MSIX.identity,
    ...(pid === undefined ? [] : ['-ProcessId', String(pid)]),
  ]);
  const pkg = line(r.stdout, 'PACKAGE');
  if (r.status !== 0 || pkg === undefined)
    throw new Error(
      `package-info.ps1: exit ${String(r.status)} ${r.stdout}${r.stderr}`.slice(0, 800),
    );
  const processPackage = line(r.stdout, 'PROCESS_PACKAGE');
  return {
    package: pkg === 'NONE' ? null : (JSON.parse(pkg) as PackageFacts),
    ...(processPackage === undefined ? {} : { processPackage }),
  };
}

export function removePackage(scriptsDir: string): void {
  ps(here('package-info.ps1', scriptsDir), ['-Name', MSIX.identity, '-Remove']);
}

/**
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\Nutflix.exe`: the execution alias the package's manifest
 * declares. Starting it runs the packaged app, with the caller's pipes as its standard handles, so
 * the ready line can be read. (Not `existsSync`: Node cannot `stat` an alias.)
 */
export function aliasPath(env: NodeJS.ProcessEnv = process.env): string {
  const local = env['LOCALAPPDATA'];
  if (local === undefined) throw new Error('LOCALAPPDATA is not set');
  return join(local, 'Microsoft', 'WindowsApps', `${APP.productName}.exe`);
}

/**
 * Sideloading (a package signed by a certificate that is not from the Store) is a machine
 * setting, `AllowAllTrustedApps`. It is on by default on a desktop Windows, and nobody can say it
 * is on for a Server image without asking, so ask, and switch it on for this throwaway runner when
 * it is not. Returns what it found and did, for the log.
 */
export function ensureSideloading(): string {
  const key = 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock';
  const policy = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\Appx';
  const read = (k: string): string => {
    const r = spawnSync('reg', ['query', k, '/v', 'AllowAllTrustedApps'], { encoding: 'utf8' });
    return r.status === 0
      ? (/AllowAllTrustedApps\s+REG_DWORD\s+(0x[0-9a-f]+)/i.exec(r.stdout)?.[1] ?? 'unreadable')
      : 'unset';
  };
  const before = `${key}=${read(key)}, ${policy}=${read(policy)}`;
  if (read(key) === '0x1' && read(policy) !== '0x0')
    return `sideloading already allowed (${before})`;
  const w = spawnSync(
    'reg',
    ['add', key, '/v', 'AllowAllTrustedApps', '/t', 'REG_DWORD', '/d', '1', '/f'],
    { encoding: 'utf8' },
  );
  if (w.status !== 0)
    throw new Error(`reg add AllowAllTrustedApps: exit ${String(w.status)} ${w.stderr}`);
  return `sideloading was not allowed (${before}); switched on for this runner (${key}=${read(key)})`;
}

/** Which Windows this is (a Server image reports a different device family than a desktop one). */
export function windowsFacts(): string {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OperatingSystemSKU,ProductType | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8' },
  );
  return r.status === 0 ? r.stdout.trim() : `unknown (exit ${String(r.status)})`;
}

/** The package deployment log's last entries: why Windows refused a package. */
export function appxLog(): string {
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-AppxLog -All | Select-Object -Last 12 | ForEach-Object { $_.TimeCreated.ToString("s") + " " + $_.Id + " " + ($_.Message -replace "\\s+", " ") }',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  return r.status === 0
    ? r.stdout.trim().slice(-3000)
    : `Get-AppxLog: exit ${String(r.status)} ${r.stderr}`;
}
