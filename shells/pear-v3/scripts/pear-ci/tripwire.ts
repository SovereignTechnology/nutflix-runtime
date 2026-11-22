/**
 * The tripwire: a host firewall rule that DROPS every packet to HyperDHT's three public bootstrap
 * addresses and COUNTS what it drops, so that "no process used the public bootstrap" is a number
 * the log shows and not a claim.
 *
 * Why this and not "we passed `--dht-bootstrap`": the flag is one place of many a process can
 * forget (a second sidecar started by a bare `pear` call has no flag at all), and the app's own
 * worker starts a DHT node on the public bootstrap at launch. A rule in the kernel sees every
 * process of the machine.
 *
 *   - Linux: iptables, one DROP rule per address in OUTPUT (a rule's packet counter is the proof).
 *   - macOS: pf, one `block drop out quick` per address (`pfctl -vsr` prints each rule's packets).
 *   - Windows: Windows Defender Firewall, one outbound Block rule over the addresses, with blocked
 *     packets logged (the log is read and its lines counted).
 *
 * The instrument is proved before it is trusted: the job sends one datagram to a documentation
 * address that the tripwire also watches (RFC 5737, never routed), and a tripwire that did not
 * count that datagram fails the job. Counting needs no packet to leave the machine.
 */
import { spawnSync } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { CANARY_IP, TRIPWIRE_IPS } from './pins.ts';

/** Packets counted per watched address. */
export type Hits = Readonly<Record<string, number>>;

export interface Tripwire {
  /** The mechanism, for the log. */
  readonly kind: 'iptables' | 'pf' | 'windows-firewall';
  /** Installs the rules (needs root or an elevated shell). */
  arm(): void;
  /** Packets dropped so far, per watched address. */
  read(): Hits;
  /** Removes the rules. */
  disarm(): void;
}

export const COMMENT = 'nutflix-ci-tripwire';

// ---- parsers (pure; the tests feed them real output shapes) ---------------------------------

/**
 * `iptables -L OUTPUT -v -n -x`:
 *
 *     pkts      bytes target     prot opt in     out     source               destination
 *        0          0 DROP       all  --  *      *       0.0.0.0/0            88.99.3.86
 *
 * (the rule's comment match adds a last column, which is ignored)
 */
export function parseIptablesCounters(text: string, ips: readonly string[] = TRIPWIRE_IPS): Hits {
  const hits = Object.fromEntries(ips.map((ip) => [ip, 0]));
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (!/^\d+$/.test(t[0] ?? '') || t[2] !== 'DROP') continue;
    const dest = t[8];
    if (dest !== undefined && dest in hits) hits[dest] = (hits[dest] ?? 0) + Number(t[0]);
  }
  return hits;
}

/**
 * `pfctl -vsr`:
 *
 *     @0 block drop out quick inet from any to 88.99.3.86
 *       [ Evaluations: 5  Packets: 0  Bytes: 0  States: 0  ]
 */
export function parsePfCounters(text: string, ips: readonly string[] = TRIPWIRE_IPS): Hits {
  const hits = Object.fromEntries(ips.map((ip) => [ip, 0]));
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^@\d+\s/.test(line)) {
      const m = /^@\d+\s+block\b.*\bto\s+(\d+\.\d+\.\d+\.\d+)/.exec(line);
      current = m?.[1] !== undefined && m[1] in hits ? m[1] : null;
      continue;
    }
    const p = /\bPackets:\s*(\d+)/.exec(line);
    if (p?.[1] !== undefined && current !== null) {
      hits[current] = (hits[current] ?? 0) + Number(p[1]);
      current = null;
    }
  }
  return hits;
}

/**
 * Windows Firewall's log (`pfirewall.log`), one line per dropped packet:
 *
 *     2026-11-22 12:00:00 DROP UDP 10.1.0.5 203.0.113.7 54321 49737 40 - - - - - - - SEND
 */
export function parseWindowsFirewallLog(text: string, ips: readonly string[] = TRIPWIRE_IPS): Hits {
  const hits = Object.fromEntries(ips.map((ip) => [ip, 0]));
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t[2] !== 'DROP') continue;
    const dest = t[5];
    if (dest !== undefined && dest in hits) hits[dest] = (hits[dest] ?? 0) + 1;
  }
  return hits;
}

/** What the log shows: the sum over the three real bootstrap addresses. */
export function publicBootstrapHits(h: Hits): number {
  return Object.entries(h)
    .filter(([ip]) => ip !== CANARY_IP)
    .reduce((n, [, c]) => n + c, 0);
}

// ---- the three mechanisms -----------------------------------------------------------------

interface Ran {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(cmd: string, args: readonly string[]): Ran {
  const r = spawnSync(cmd, [...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function must(what: string, r: Ran): Ran {
  if (r.status !== 0)
    throw new Error(
      `${what} exited ${String(r.status)}: ${(r.stdout + r.stderr).trim().slice(-600)}`,
    );
  return r;
}

function iptables(): Tripwire {
  const ipt = (...args: string[]): Ran => run('sudo', ['-n', 'iptables', '-w', '10', ...args]);
  return {
    kind: 'iptables',
    arm() {
      for (const ip of TRIPWIRE_IPS)
        must(
          `iptables -I OUTPUT ${ip}`,
          ipt('-I', 'OUTPUT', '1', '-d', ip, '-m', 'comment', '--comment', COMMENT, '-j', 'DROP'),
        );
    },
    read() {
      return parseIptablesCounters(
        must('iptables -L OUTPUT', ipt('-L', 'OUTPUT', '-v', '-n', '-x')).stdout,
      );
    },
    disarm() {
      for (const ip of TRIPWIRE_IPS)
        ipt('-D', 'OUTPUT', '-d', ip, '-m', 'comment', '--comment', COMMENT, '-j', 'DROP');
    },
  };
}

function pf(work: string): Tripwire {
  const rules = join(work, 'tripwire-pf.conf');
  const pfctl = (...args: string[]): Ran => run('sudo', ['-n', 'pfctl', ...args]);
  let token: string | null = null;
  return {
    kind: 'pf',
    arm() {
      writeFileSync(
        rules,
        `# ${COMMENT}: drop and count; the addresses are HyperDHT's public bootstrap and one canary\n` +
          TRIPWIRE_IPS.map((ip) => `block drop out quick inet from any to ${ip}\n`).join(''),
      );
      must('pfctl -f', pfctl('-f', rules));
      // -E takes a reference ("Token : n") and enables pf when it was off; -X n drops it again.
      const e = must('pfctl -E', pfctl('-E'));
      token = /Token\s*:\s*(\d+)/.exec(e.stdout + e.stderr)?.[1] ?? null;
    },
    read() {
      return parsePfCounters(must('pfctl -vsr', pfctl('-vsr')).stdout);
    },
    disarm() {
      pfctl('-F', 'rules');
      if (token !== null) pfctl('-X', token);
    },
  };
}

function windowsFirewall(scriptsDir: string): Tripwire {
  const script = join(scriptsDir, 'windows', 'tripwire.ps1');
  const ps = (...args: string[]): Ran =>
    run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args,
    ]);
  let log = '';
  let offset = '0';
  return {
    kind: 'windows-firewall',
    arm() {
      const r = must(
        'tripwire.ps1 arm',
        ps('-Action', 'arm', '-Addresses', TRIPWIRE_IPS.join(',')),
      );
      process.stdout.write(r.stdout);
      log = /^LOG=(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? '';
      offset = /^OFFSET=(\d+)$/m.exec(r.stdout)?.[1] ?? '0';
      if (log === '') throw new Error('tripwire.ps1 arm did not say where the firewall log is');
    },
    read() {
      const r = must(
        'tripwire.ps1 read',
        ps('-Action', 'read', '-Addresses', TRIPWIRE_IPS.join(','), '-Log', log, '-Offset', offset),
      );
      return parseWindowsFirewallLog(r.stdout);
    },
    disarm() {
      ps('-Action', 'disarm');
    },
  };
}

/** The tripwire for this machine. `work` is a scratch directory, `scriptsDir` is `scripts/pear-ci`. */
export function createTripwire(platform: string, work: string, scriptsDir: string): Tripwire {
  switch (platform) {
    case 'linux':
      return iptables();
    case 'darwin':
      return pf(work);
    case 'win32':
      return windowsFirewall(scriptsDir);
    default:
      throw new Error(`no tripwire for ${platform}`);
  }
}

/**
 * One datagram to the canary address. Whether the send errors (an iptables DROP in OUTPUT answers
 * EPERM) or not (pf and the Windows firewall drop silently) does not matter: the count does.
 */
export function sendCanary(): Promise<string> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    s.once('error', (e) => {
      s.close();
      resolve(`send error: ${e.message}`);
    });
    s.send(Buffer.from(COMMENT), 49737, CANARY_IP, (e) => {
      s.close();
      resolve(e === null ? 'sent' : `send error: ${e.message}`);
    });
  });
}

/** Polls `tw.read()` until the canary was counted (the Windows log lags), or `waitMs` ran out. */
export async function proveTripwire(tw: Tripwire, waitMs: number): Promise<Hits> {
  const before = tw.read();
  if (Object.values(before).some((n) => n !== 0))
    throw new Error(`the tripwire counted packets before any test: ${JSON.stringify(before)}`);
  const how = await sendCanary();
  process.stdout.write(`tripwire canary: one datagram to ${CANARY_IP}: ${how}\n`);
  const until = Date.now() + waitMs;
  for (;;) {
    const now = tw.read();
    if ((now[CANARY_IP] ?? 0) >= 1) return now;
    if (Date.now() > until)
      throw new Error(
        `the tripwire (${tw.kind}) did not count the canary datagram in ${String(waitMs)} ms: it counts nothing, so it proves nothing`,
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
}
