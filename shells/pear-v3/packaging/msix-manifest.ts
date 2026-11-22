/**
 * The `.msix`'s `AppxManifest.xml`: `electron-windows-msix`'s own template (the one
 * `@electron-forge/maker-msix` fills in), filled in with the same values `forge-config.ts` gave
 * the maker before, plus ONE addition: an app execution alias.
 *
 * Why the alias: a packaged desktop app started from the Start menu or by package activation has
 * no standard output a script can read, and the app's only output is its `NUTFLIX_SHELL` lines
 * (`src/main/log.ts`). Started through its alias, the packaged app (with package identity, from the
 * installed package) gets the caller's pipes, and CI can read its ready line. The alias also lets a
 * person with a terminal run `Nutflix.exe` and read the same lines, or pass it a switch. The app
 * takes no switch of its own for this and no code changed: only the manifest says the name.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import { APP, MSIX } from './identity.ts';

/** The template that ships inside `electron-windows-msix` (a dependency of the MSIX maker). */
export function templatePath(): string {
  const pkg = createRequire(import.meta.url).resolve('electron-windows-msix/package.json');
  return join(dirname(pkg), 'static', 'templates', 'AppxManifest.xml.in');
}

/** `1.2.3` to `1.2.3.0`; a four-part version stays. (A pre-release has no place in a package version.) */
export function windowsVersion(version: string): string {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(version)) return version;
  if (/^\d+\.\d+\.\d+$/.test(version)) return `${version}.0`;
  throw new Error(`${version} is not a package version: a.b.c or a.b.c.d`);
}

const xml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

const ALIAS = `<Extensions>
        <uap3:Extension Category="windows.appExecutionAlias" Executable="app\\{{AppExecutable}}" EntryPoint="Windows.FullTrustApplication">
          <uap3:AppExecutionAlias>
            <desktop:ExecutionAlias Alias="{{Alias}}" />
          </uap3:AppExecutionAlias>
        </uap3:Extension>
      </Extensions>
    `;

export interface ManifestOptions {
  /** The app's version (`a.b.c`). */
  readonly version: string;
  readonly arch: 'x64' | 'arm64';
  /** The template's text; the file inside `electron-windows-msix` by default. */
  readonly template?: string;
}

/** The manifest the MSIX maker packs. */
export function appxManifest(o: ManifestOptions): string {
  const template = o.template ?? readFileSync(templatePath(), 'utf8');
  const values: Record<string, string> = {
    IdentityName: MSIX.identity,
    AppDisplayName: APP.productName,
    MinOSVersion: MSIX.minOsVersion,
    MaxOSVersionTested: MSIX.minOsVersion,
    Version: windowsVersion(o.version),
    DisplayName: APP.productName,
    // The template writes `CN=` itself.
    PublisherName: MSIX.publisher.replace(/^CN=/, ''),
    PublisherDisplayName: MSIX.publisherDisplayName,
    PackageDescription: APP.description,
    PackageBackgroundColor: 'transparent',
    AppExecutable: `${APP.productName}.exe`,
    ProcessorArchitecture: o.arch,
    Alias: MSIX.alias,
  };
  const marker = '</uap:VisualElements>';
  if (template.split(marker).length !== 2)
    throw new Error(
      'the manifest template has no single </uap:VisualElements> to add the alias after',
    );
  const withAlias = template.replace(marker, `${marker}\n      ${ALIAS.trimEnd()}`);
  const out = withAlias.replace(/\{\{(\w+)\}\}/g, (all, name: string) => {
    const v = values[name];
    if (v === undefined)
      throw new Error(`the manifest template has a placeholder ${all} we do not fill`);
    return xml(v);
  });
  return out;
}

/** Writes the manifest for `arch` to `file` and returns the path (the maker's `appManifest`). */
export function writeAppxManifest(file: string, version: string, arch: 'x64' | 'arm64'): string {
  writeFileSync(file, appxManifest({ version, arch }));
  return file;
}
