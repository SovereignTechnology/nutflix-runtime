/**
 * The release path bakes in the production trust root and refuses anything else; the test path
 * takes a throwaway root and refuses the production key.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { decode } from 'nostr-tools/nip19';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_SETTINGS,
  SCOPED_RELAY,
} from '../../../../packages/renderer/src/settings/defaults.ts';
import { parseCli } from '../../scripts/cli-options.ts';
import { encodeBakedRoot, parseTrustRoot, type TrustRoot } from '../../src/update/root.ts';
import { STAGED } from '../identity.ts';
import { appxManifest } from '../msix-manifest.ts';
import { REPO_ROOT } from '../paths.ts';
import {
  RELEASE_NOTICE_RELAYS,
  RELEASE_PUBKEY,
  RELEASE_UPGRADE_LINK,
  assertNoUpgradeLink,
  assertReleaseRoot,
  assertStagedRoot,
  assertTestRoot,
  bakedRootIn,
  releaseRoot,
  testRootFromText,
} from '../update-root.ts';

const LINK = `pear://${'y'.repeat(52)}`;
const THROWAWAY = 'ab'.repeat(32);

const testRoot = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  v: 1,
  channel: 'test',
  pubkey: THROWAWAY,
  relays: ['ws://127.0.0.1:7777'],
  upgrade: LINK,
  dht: ['127.0.0.1:49737'],
  delayMs: 0,
  ...over,
});

const vendored = (): string =>
  readFileSync(
    join(REPO_ROOT, 'vendor', 'nutflix-pear', 'scripts', 'release-manifest.mjs'),
    'utf8',
  );

describe('the production root', () => {
  it('is the SovTech release key nutflix-pear signs with', () => {
    const npub = /SOVTECH_NPUB = '(npub1[a-z0-9]+)'/.exec(vendored())?.[1];
    expect(npub).toBeDefined();
    const d = decode(npub ?? '');
    expect(d.type).toBe('npub');
    expect(d.data).toBe(RELEASE_PUBKEY);
  });

  it("reads notices from the app's own default relays, the network's first", () => {
    expect(RELEASE_NOTICE_RELAYS).toEqual([
      SCOPED_RELAY,
      ...DEFAULT_SETTINGS.relays.map((r) => r.url),
    ]);
  });

  it('refuses to let a runner launch a build that would start an updater', () => {
    const bundle = (r: TrustRoot): string => `var root = "${encodeBakedRoot(r)}";`;
    expect(() => {
      assertNoUpgradeLink(bundle(releaseRoot()));
    }).not.toThrow();
    expect(() => {
      assertNoUpgradeLink(bundle(parseTrustRoot(testRoot())));
    }).toThrow(/public DHT/);
  });

  it('is inert: no upgrade link until the owner has provisioned one', () => {
    expect(RELEASE_UPGRADE_LINK).toBeNull();
    const r = releaseRoot();
    expect(r).toMatchObject({ channel: 'release', upgrade: null, dht: null, delayMs: null });
    expect(() => {
      assertReleaseRoot(r);
    }).not.toThrow();
  });

  it.each([
    ['a test root', testRoot()],
    ['another key', { ...releaseRoot(), pubkey: THROWAWAY }],
    ['another relay list', { ...releaseRoot(), relays: ['wss://relay.example.org'] }],
    ['a link nobody reviewed', { ...releaseRoot(), upgrade: LINK }],
  ])('refuses %s for a release', (_n, x) => {
    expect(() => {
      assertReleaseRoot(parseTrustRoot(x));
    }).toThrow();
  });
});

describe('a test root', () => {
  it('is accepted with a throwaway key on loopback', () => {
    expect(testRootFromText(JSON.stringify(testRoot())).pubkey).toBe(THROWAWAY);
  });

  it('refuses the production key', () => {
    expect(() => testRootFromText(JSON.stringify(testRoot({ pubkey: RELEASE_PUBKEY })))).toThrow(
      /production key/,
    );
  });

  it('refuses the release channel, a public relay and a public DHT', () => {
    expect(() => {
      assertTestRoot(releaseRoot());
    }).toThrow();
    expect(() =>
      testRootFromText(JSON.stringify(testRoot({ relays: ['wss://nos.lol'] }))),
    ).toThrow();
    expect(() =>
      testRootFromText(JSON.stringify(testRoot({ dht: ['88.99.3.86:49737'] }))),
    ).toThrow();
  });

  it('refuses a file that is not JSON', () => {
    expect(() => testRootFromText('not json')).toThrow();
  });
});

describe('the command line', () => {
  it.each(['stage', 'package', 'make', 'build'])('%s takes no trust root and no version', (cmd) => {
    expect(() => parseCli([cmd, '--update-root', 'r.json'])).toThrow(/refused outside test-build/);
    expect(() => parseCli([cmd, '--app-version', '1.2.3'])).toThrow(/refused outside test-build/);
    expect(parseCli([cmd]).updateRootFile).toBeUndefined();
  });

  it('test-build needs both, and a plain version', () => {
    expect(() => parseCli(['test-build'])).toThrow(/needs/);
    expect(() => parseCli(['test-build', '--update-root', 'r.json'])).toThrow(/needs/);
    expect(() =>
      parseCli(['test-build', '--update-root', 'r.json', '--app-version', '1.2']),
    ).toThrow(/a\.b\.c/);
    const o = parseCli(['test-build', '--update-root', 'r.json', '--app-version', '1.2.3']);
    expect(o.command).toBe('test-build');
    expect(o.appVersion).toBe('1.2.3');
  });
});

describe('what a stage actually holds', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const staged = (bundle: string): string => {
    const d = mkdtempSync(join(tmpdir(), 'update-root-'));
    dirs.push(d);
    mkdirSync(join(d, 'main'));
    writeFileSync(join(d, STAGED.updateWorker), bundle);
    return d;
  };
  const bundleOf = (r: TrustRoot): string => `var root = "${encodeBakedRoot(r)}";\n`;
  const test = parseTrustRoot(testRoot());

  it('reads the one baked root back', () => {
    expect(bakedRootIn(bundleOf(releaseRoot()))).toEqual(releaseRoot());
  });

  it('refuses a bundle with no root, or two', () => {
    expect(() => bakedRootIn('var x = 1;')).toThrow(/0 update roots/);
    expect(() => bakedRootIn(bundleOf(releaseRoot()) + bundleOf(test))).toThrow(/2 update roots/);
  });

  it('passes a release stage holding the production root', () => {
    const d = staged(bundleOf(releaseRoot()));
    expect(() => {
      assertStagedRoot(d, releaseRoot(), 'release');
    }).not.toThrow();
  });

  it('REFUSES a release stage holding a throwaway root', () => {
    const d = staged(bundleOf(test));
    expect(() => {
      assertStagedRoot(d, test, 'release');
    }).toThrow(/release/);
    expect(() => {
      assertStagedRoot(d, releaseRoot(), 'release');
    }).toThrow(/does not hold/);
  });

  it('refuses a test stage holding the production root', () => {
    const d = staged(bundleOf(releaseRoot()));
    expect(() => {
      assertStagedRoot(d, releaseRoot(), 'test');
    }).toThrow();
  });
});

describe('the .msix a build with a link needs', () => {
  it('asks for nothing extra without a link', () => {
    const xml = appxManifest({ version: '0.1.0', arch: 'x64' });
    expect(xml).not.toMatch(
      /packageManagement|unvirtualizedResources|FileSystemWriteVirtualization/,
    );
  });

  it('asks for package management and turns write virtualization off with one', () => {
    const xml = appxManifest({ version: '0.1.1', arch: 'x64', updates: true });
    expect(xml).toContain('<rescap:Capability Name="packageManagement" />');
    expect(xml).toContain('<rescap:Capability Name="unvirtualizedResources" />');
    expect(xml).toContain(
      '<desktop6:FileSystemWriteVirtualization>disabled</desktop6:FileSystemWriteVirtualization>',
    );
    expect(xml).toContain('IgnorableNamespaces="uap uap3 desktop2 desktop6"');
    expect(xml.indexOf('FileSystemWriteVirtualization')).toBeLessThan(xml.indexOf('</Properties>'));
  });

  it('refuses a template it does not recognise', () => {
    expect(() =>
      appxManifest({ version: '0.1.1', arch: 'x64', updates: true, template: '<Package />' }),
    ).toThrow(/exactly one/);
  });
});
