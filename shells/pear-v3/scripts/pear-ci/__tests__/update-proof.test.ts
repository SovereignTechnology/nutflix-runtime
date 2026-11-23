/**
 * The install job's own instruments for the update gate: the notices it writes must be what the app
 * reads, the forged ones must be refused for the right reason, and the sinkhole must cover every
 * public relay the app's sources name.
 */
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { RELEASE_NOTICE_RELAYS } from '../../../packaging/update-root.ts';
import { REPO_ROOT } from '../../../packaging/paths.ts';
import { readNotice } from '../../../src/update/notice.ts';
import { parseTrustRoot } from '../../../src/update/root.ts';
import { NoticeRelay } from '../notice-relay.ts';
import { hostsFile, hostsIn, publicHosts, quotedHostsIn, sinkholeLines } from '../sinkhole.ts';
import {
  parsePfCounters,
  parseWindowsFirewallLog,
  pfRules,
  publicBootstrapHits,
} from '../tripwire.ts';
import { CANARY_IP } from '../pins.ts';
import { forgedNotice, noticeTemplate, patchVersion, type NoticeFields } from '../update-proof.ts';

const KEY = 'y'.repeat(52);
const SK = generateSecretKey();
const OTHER = generateSecretKey();
const ROOT = parseTrustRoot({
  v: 1,
  channel: 'test',
  pubkey: getPublicKey(SK),
  relays: ['ws://127.0.0.1:7777'],
  upgrade: `pear://${KEY}`,
  dht: ['127.0.0.1:49737'],
  delayMs: 0,
});
const NOW = 1_800_000_000;
const FIELDS: NoticeFields = {
  createdAt: NOW,
  version: '0.1.2',
  verlink: `pear://0.9.${KEY}`,
  artifact: 'Nutflix-linux-x64.AppImage',
  sha256: 'ab'.repeat(32),
  bytes: 1234,
};

describe('the notices the job writes', () => {
  it('reads as a notice in the app', () => {
    const r = readNotice(finalizeEvent(noticeTemplate(FIELDS), SK), ROOT, NOW);
    expect(r.notice?.verlink).toBe(FIELDS.verlink);
    expect(r.notice?.artifacts.get(FIELDS.artifact)?.sha256).toBe(FIELDS.sha256);
  });

  it('is refused from the wrong key under its own name', () => {
    expect(readNotice(finalizeEvent(noticeTemplate(FIELDS), OTHER), ROOT, NOW).refused).toBe(
      'author',
    );
  });

  it('is refused when it claims the release key without its signature', () => {
    expect(readNotice(forgedNotice(FIELDS, ROOT.pubkey, OTHER), ROOT, NOW).refused).toBe(
      'signature',
    );
  });

  it('counts versions up by patch', () => {
    expect(patchVersion('0.1.0', 2)).toBe('0.1.2');
    expect(() => patchVersion('0.1', 1)).toThrow();
  });
});

describe('the loopback relay', () => {
  it('is on 127.0.0.1, and answers every subscription with all it holds', async () => {
    const relay = await NoticeRelay.start();
    try {
      expect(relay.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
      relay.hold([{ a: 1 }]);
      const got = await new Promise<unknown[]>((resolve, reject) => {
        const ws = new WebSocket(relay.url);
        const msgs: unknown[] = [];
        ws.on('error', reject);
        ws.on('open', () => {
          ws.send(JSON.stringify(['REQ', 's', { authors: ['someone-else'] }]));
        });
        ws.on('message', (d: Buffer) => {
          const m = JSON.parse(d.toString('utf8')) as unknown[];
          msgs.push(m);
          if (m[0] === 'EOSE') {
            ws.close();
            resolve(msgs);
          }
        });
      });
      expect(got).toEqual([
        ['EVENT', 's', { a: 1 }],
        ['EOSE', 's'],
      ]);
      expect(relay.reqs).toBe(1);
    } finally {
      await relay.stop();
    }
  });
});

describe('the sinkhole', () => {
  it('finds relay and STUN hosts, and leaves loopback and reserved names alone', () => {
    expect(
      hostsIn(
        `'wss://relay.one.sample.net/x', "ws://relay.two.dev:7777", stun:stun.three.org:3478,
         turns:turn.four.io, ws://127.0.0.1:7777, wss://a.example, wss://x.invalid, wss://b.test,
         wss://relay.example.org, https://not-a-relay.org`,
      ),
    ).toEqual(['relay.one.sample.net', 'relay.two.dev', 'stun.three.org', 'turn.four.io']);
  });

  it('finds a STUN server the settings keep as a bare host:port', () => {
    const text = `export const NFX_NETWORK = 'nfx:testnet:1';
      export const SCOPED = 'wss://relay.one.sample.net' as RelayUrl;
      export const DEFAULT_STUN_SERVERS = Object.freeze([
        'stun.two.sample.net:3478' as StunServer,
        "stun.three.dev",
      ]);
      const other = ['system', '0.1.0', '127.0.0.1:3478', 'stun.four.example:3478'];`;
    expect(hostsIn(text)).toEqual(['relay.one.sample.net']);
    expect(quotedHostsIn(text)).toEqual(['stun.three.dev', 'stun.two.sample.net']);
  });

  it('covers the renderer’s default relays and every release notice relay', () => {
    const hosts = publicHosts(REPO_ROOT);
    for (const h of ['relay.nutflix.xyz', 'relay.primal.net', 'relay.ditto.pub'])
      expect(hosts).toContain(h);
    for (const r of RELEASE_NOTICE_RELAYS) expect(hosts).toContain(r.slice('wss://'.length));
  });

  it('writes each host to both loopbacks', () => {
    expect(sinkholeLines(['a.b'])).toContain('127.0.0.1 a.b\n::1 a.b\n');
    expect(hostsFile('linux')).toBe('/etc/hosts');
    expect(hostsFile('win32', { SystemRoot: 'D:\\W' }).endsWith('hosts')).toBe(true);
  });
});

describe('the tripwire, over more addresses than the bootstrap', () => {
  const ips = ['88.99.3.86', '104.16.0.1', CANARY_IP];

  it('counts a relay address as a public hit', () => {
    const log = '2026-11-22 12:00:00 DROP TCP 10.1.0.5 104.16.0.1 54321 443 40 - - - - - - - SEND';
    const hits = parseWindowsFirewallLog(log, ips);
    expect(hits['104.16.0.1']).toBe(1);
    expect(publicBootstrapHits(hits)).toBe(1);
  });

  it('keeps one pf rule per address, with the optimizer that would fold them off', () => {
    const many = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5', '6.6.6.6', CANARY_IP];
    const text = pfRules(many);
    expect(text).toContain('set ruleset-optimization none\n');
    expect(text.indexOf('set ruleset')).toBeLessThan(text.indexOf('block drop'));
    expect(text.match(/^block drop out quick inet from any to /gm)).toHaveLength(many.length);
  });

  it('does not count the canary as public', () => {
    const pf = `block drop out quick inet from any to ${CANARY_IP}\n  [ Evaluations: 5  Packets: 3  Bytes: 0  States: 0  ]\n`;
    const hits = parsePfCounters(pf, ips);
    expect(hits[CANARY_IP]).toBe(3);
    expect(publicBootstrapHits(hits)).toBe(0);
  });
});
