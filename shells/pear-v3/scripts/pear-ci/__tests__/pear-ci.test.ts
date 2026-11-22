import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import DHT from 'hyperdht';
import { afterEach, describe, expect, it } from 'vitest';

import { APP, MSIX, TARGETS } from '../../../packaging/identity.ts';
import { appxManifest, windowsVersion } from '../../../packaging/msix-manifest.ts';
import {
  deploymentPackageJson,
  expectedDeploymentEntries,
  manifestProblems,
  manifestSummary,
  treeManifest,
} from '../deployment.ts';
import {
  PEAR_PINS,
  PUBLIC_BOOTSTRAP_IPS,
  CANARY_IP,
  TRIPWIRE_IPS,
  pearDownloadUrl,
} from '../pins.ts';
import { isolatedEnv, platformDir } from '../pear.ts';
import {
  assertLoopbackBootstrap,
  bootstrapProof,
  failureMessage,
  field,
  lastRecord,
  parseRecords,
  succeeded,
} from '../records.ts';
import {
  parseIptablesCounters,
  parsePfCounters,
  parseWindowsFirewallLog,
  publicBootstrapHits,
} from '../tripwire.ts';

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'pear-ci-test-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('the pinned Pear CLI', () => {
  it('has one pinned release asset per target, each a sha256 and a size', () => {
    const targets = TARGETS.map((t) => `${t.platform}-${t.arch}`).sort();
    expect(Object.keys(PEAR_PINS).sort()).toEqual(targets);
    for (const [name, pin] of Object.entries(PEAR_PINS)) {
      expect(pin.sha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.size, name).toBeGreaterThan(1_000_000);
      expect(pin.asset, name).toBe(`pear-${name}.zip`);
      expect(pin.binary, name).toBe(name.startsWith('win32') ? 'pear.exe' : 'pear');
      expect(pearDownloadUrl(pin)).toBe(
        `https://github.com/holepunchto/pear/releases/download/v3.7.0/${pin.asset}`,
      );
    }
  });

  it('never uses the DHT to get the CLI: the URL is HTTPS on github.com', () => {
    for (const pin of Object.values(PEAR_PINS))
      expect(pearDownloadUrl(pin)).toMatch(/^https:\/\/github\.com\/holepunchto\/pear\//);
  });
});

describe('the tripwire watches the public bootstrap and a canary', () => {
  it('lists exactly the default bootstrap nodes of the installed hyperdht, then a canary', () => {
    const defaults = (Reflect.get(DHT, 'BOOTSTRAP') as readonly string[]).map(
      (n) => /^(\d+\.\d+\.\d+\.\d+)@/.exec(n)?.[1],
    );
    expect([...PUBLIC_BOOTSTRAP_IPS].sort()).toEqual([...defaults].sort());
    expect(TRIPWIRE_IPS).toEqual([...PUBLIC_BOOTSTRAP_IPS, CANARY_IP]);
    // RFC 5737 TEST-NET-3: never routed.
    expect(CANARY_IP).toMatch(/^203\.0\.113\./);
  });

  it('reads an iptables rule counter', () => {
    const text = `Chain OUTPUT (policy ACCEPT 0 packets, 0 bytes)
    pkts      bytes target     prot opt in     out     source               destination
       0        0 DROP       all  --  *      *       0.0.0.0/0            203.0.113.7          /* nutflix-ci-tripwire */
       3      180 DROP       all  --  *      *       0.0.0.0/0            88.99.3.86           /* nutflix-ci-tripwire */
      12     2400 ACCEPT     all  --  *      *       0.0.0.0/0            1.1.1.1
`;
    const h = parseIptablesCounters(text);
    expect(h['88.99.3.86']).toBe(3);
    expect(h[CANARY_IP]).toBe(0);
    expect(h['142.93.90.113']).toBe(0);
    expect(publicBootstrapHits(h)).toBe(3);
  });

  it('reads a pf rule counter', () => {
    const text = `@0 block drop out quick inet from any to 88.99.3.86
  [ Evaluations: 10  Packets: 0  Bytes: 0  States: 0     ]
  [ Inserted: uid 0 pid 123 State Creations: 0   ]
@1 block drop out quick inet from any to 203.0.113.7
  [ Evaluations: 9  Packets: 2  Bytes: 112  States: 0     ]
@2 pass in all
  [ Evaluations: 9  Packets: 99  Bytes: 1  States: 0     ]
`;
    const h = parsePfCounters(text);
    expect(h[CANARY_IP]).toBe(2);
    expect(h['88.99.3.86']).toBe(0);
    expect(publicBootstrapHits(h)).toBe(0);
  });

  it('counts dropped packets in the Windows Firewall log', () => {
    const text = `#Version: 1.5
#Fields: date time action protocol src-ip dst-ip src-port dst-port size tcpflags tcpsyn tcpack tcpwin icmptype icmpcode info path
2026-11-22 12:00:00 DROP UDP 10.1.0.5 203.0.113.7 54321 49737 40 - - - - - - - SEND
2026-11-22 12:00:01 DROP UDP 10.1.0.5 203.0.113.7 54321 49737 40 - - - - - - - SEND
2026-11-22 12:00:02 ALLOW UDP 10.1.0.5 8.8.8.8 54321 53 40 - - - - - - - SEND
2026-11-22 12:00:03 DROP UDP 10.1.0.5 138.68.147.8 54321 49737 40 - - - - - - - SEND
`;
    const h = parseWindowsFirewallLog(text);
    expect(h[CANARY_IP]).toBe(2);
    expect(h['138.68.147.8']).toBe(1);
    expect(publicBootstrapHits(h)).toBe(1);
  });
});

describe('what the Pear CLI prints', () => {
  it('parses --json records and skips everything else', () => {
    const out = [
      'Pear ~ banner',
      '{"cmd":"touch","tag":"final","data":{"success":true,"key":"k","link":"pear://k"}}',
      '{"not":"a record"}',
      '{broken',
      '{"cmd":"install","tag":"error","data":{"success":false,"code":"ERR_X","message":"it failed"}}',
    ].join('\n');
    const r = parseRecords(out);
    expect(r.map((x) => x.tag)).toEqual(['final', 'error']);
    expect(field(lastRecord(r, 'final'), 'link')).toBe('pear://k');
    expect(succeeded(r)).toBe(true);
    expect(failureMessage(r)).toBe('it failed');
  });

  it('reads the sidecar log for the bootstrap it was given', () => {
    const log = `[2026-11-22T12:00:00.000Z] INF sidecar - Sidecar Booting
[2026-11-22T12:00:01.000Z] INF sidecar DHT bootstrap set [ { host: '127.0.0.1', port: 49737 } ]
[2026-11-22T12:00:01.100Z] INF sidecar - Sidecar Booted`;
    const p = bootstrapProof(log, '127.0.0.1:49737');
    expect(p).toMatchObject({ set: true, names: true, readKnownNodes: false });
    const public_ = bootstrapProof(
      '[…] INF dht - DHT known-nodes read from database 100 nodes',
      '127.0.0.1:49737',
    );
    expect(public_).toMatchObject({ set: false, readKnownNodes: true });
  });

  it('refuses a bootstrap that is not loopback', () => {
    expect(() => {
      assertLoopbackBootstrap('127.0.0.1:49737');
    }).not.toThrow();
    for (const bad of [
      '88.99.3.86:49737',
      'node1.hyperdht.org:49737',
      '127.0.0.1:49737,1.2.3.4:5',
      '',
    ])
      expect(() => {
        assertLoopbackBootstrap(bad);
      }, bad).toThrow();
  });

  it('keeps Pear in the home it was given, with no XDG override', () => {
    const env = isolatedEnv('/h/ome', { HOME: '/real', XDG_CONFIG_HOME: '/x', PATH: '/bin' });
    expect(env['HOME']).toBe('/h/ome');
    expect(env['XDG_CONFIG_HOME']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
    expect(env['PEAR_INSTALL_NO_PATH']).toBe('1');
    expect(platformDir('/h', 'linux')).toBe(join('/h', '.config', 'pear'));
  });
});

describe('the deployment', () => {
  it('is five entries named by what `pear build` requires', () => {
    expect(expectedDeploymentEntries(TARGETS)).toEqual([
      'by-arch/darwin-arm64/app/Nutflix.app',
      'by-arch/darwin-x64/app/Nutflix.app',
      'by-arch/linux-arm64/app/Nutflix.AppImage',
      'by-arch/linux-x64/app/Nutflix.AppImage',
      'by-arch/win32-x64/app/Nutflix.msix',
    ]);
  });

  it('has a package.json that matches the app and points nowhere', () => {
    const pj = JSON.parse(deploymentPackageJson({ version: '0.1.0' })) as Record<string, unknown>;
    expect(pj).toMatchObject({ name: APP.name, productName: 'Nutflix', version: '0.1.0' });
    expect(pj['upgrade']).toBeUndefined();
  });

  it('compares trees by bytes, executable bit and symlink target', async () => {
    const a = tmp();
    const b = tmp();
    for (const d of [a, b]) {
      mkdirSync(join(d, 'sub'));
      writeFileSync(join(d, 'sub', 'f.txt'), 'same');
      writeFileSync(join(d, 'run.sh'), '#!/bin/sh\n');
      if (process.platform !== 'win32') {
        chmodSync(join(d, 'run.sh'), 0o755);
        symlinkSync('sub/f.txt', join(d, 'link'));
      }
    }
    const ma = await treeManifest(a);
    expect(manifestProblems(ma, await treeManifest(b))).toEqual([]);
    expect(manifestSummary(ma).files).toBe(2);

    writeFileSync(join(b, 'sub', 'f.txt'), 'different');
    writeFileSync(join(b, 'extra'), 'x');
    const problems = manifestProblems(ma, await treeManifest(b));
    expect(problems).toContain('sub/f.txt: the bytes differ');
    expect(problems).toContain('extra after: extra');
    if (process.platform !== 'win32') {
      rmSync(join(b, 'link'));
      symlinkSync('elsewhere', join(b, 'link'));
      expect(manifestProblems(ma, await treeManifest(b)).join('\n')).toContain('link: link to');
      chmodSync(join(b, 'run.sh'), 0o644);
      expect(manifestProblems(ma, await treeManifest(b)).join('\n')).toContain(
        'run.sh: executable',
      );
    }
  });
});

describe('the .msix manifest', () => {
  it('is the maker template filled in, plus one execution alias', () => {
    const xml = appxManifest({ version: '0.1.0', arch: 'x64' });
    expect(xml).not.toMatch(/\{\{/);
    expect(xml).toContain(`Name="${MSIX.identity}"`);
    expect(xml).toContain('Publisher="CN=Sovereign Technology (TEST)"');
    expect(xml).toContain('Version="0.1.0.0"');
    expect(xml).toContain('ProcessorArchitecture="x64"');
    expect(xml).toContain('Executable="app\\Nutflix.exe"');
    expect(xml.match(/windows\.appExecutionAlias/g)).toHaveLength(1);
    expect(xml).toContain('<desktop:ExecutionAlias Alias="Nutflix.exe" />');
    // The alias sits inside the application, after its visual elements.
    expect(xml.indexOf('</uap:VisualElements>')).toBeLessThan(xml.indexOf('<Extensions>'));
    expect(xml.indexOf('</Extensions>')).toBeLessThan(xml.indexOf('</Application>'));
  });

  it('turns a semver into a four-part package version', () => {
    expect(windowsVersion('1.2.3')).toBe('1.2.3.0');
    expect(windowsVersion('1.2.3.4')).toBe('1.2.3.4');
    expect(() => windowsVersion('1.2.3-rc.1')).toThrow();
  });
});
