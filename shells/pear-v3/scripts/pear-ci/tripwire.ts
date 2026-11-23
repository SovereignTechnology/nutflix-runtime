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
 * What it watches is HyperDHT's public bootstrap plus, since the update gate, the addresses of every
 * public Nostr relay the app can name (`sinkhole.ts` resolves them before it blackholes the names).
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
  /** The raw state of the mechanism, for the log when it does not count. */
  describe(): string;
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
 * `pfctl -vsr` (macOS 15 prints no `@n` before a rule; other pfctl builds do):
 *
 *     block drop out quick inet from any to 88.99.3.86
 *       [ Evaluations: 5  Packets: 0  Bytes: 0  States: 0  ]
 */
export function parsePfCounters(text: string, ips: readonly string[] = TRIPWIRE_IPS): Hits {
  const hits = Object.fromEntries(ips.map((ip) => [ip, 0]));
  let current: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    // A rule line starts with `block` (macOS) or `@<n> block` (pfctl elsewhere); its counters follow.
    if (/^\s*(@\d+\s+)?(block|pass|match|anchor)\b/.test(line)) {
      const ip = /^\s*(@\d+\s+)?block\b/.test(line)
        ? ips.find((a) => new RegExp(`\\b${a.replaceAll('.', '\\.')}\\b`).test(line))
        : undefined;
      current = ip ?? null;
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

/** What the log shows: the sum over every real address watched (all but the canary). */
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

function iptables(ips: readonly string[]): Tripwire {
  const ipt = (...args: string[]): Ran => run('sudo', ['-n', 'iptables', '-w', '10', ...args]);
  return {
    kind: 'iptables',
    arm() {
      for (const ip of ips)
        must(
          `iptables -I OUTPUT ${ip}`,
          ipt('-I', 'OUTPUT', '1', '-d', ip, '-m', 'comment', '--comment', COMMENT, '-j', 'DROP'),
        );
    },
    read() {
      return parseIptablesCounters(
        must('iptables -L OUTPUT', ipt('-L', 'OUTPUT', '-v', '-n', '-x')).stdout,
        ips,
      );
    },
    disarm() {
      for (const ip of ips)
        ipt('-D', 'OUTPUT', '-d', ip, '-m', 'comment', '--comment', COMMENT, '-j', 'DROP');
    },
    describe() {
      return ipt('-L', 'OUTPUT', '-v', '-n', '-x').stdout;
    },
  };
}

/**
 * One rule per address, and the optimizer off: from six addresses pfctl folds such rules into one
 * rule over a table, whose counter cannot say which address was hit.
 */
export function pfRules(ips: readonly string[]): string {
  return (
    `# ${COMMENT}: drop and count the public addresses and one canary\n` +
    'set ruleset-optimization none\n' +
    ips.map((ip) => `block drop out quick inet from any to ${ip}\n`).join('')
  );
}

function pf(work: string, ips: readonly string[]): Tripwire {
  const rules = join(work, 'tripwire-pf.conf');
  const pfctl = (...args: string[]): Ran => run('sudo', ['-n', 'pfctl', ...args]);
  let token: string | null = null;
  const describe = (): string => {
    const shown = ['-s info', '-vsr', '-s Anchors'].map((a) => {
      const r = pfctl(...a.split(' '));
      return `$ pfctl ${a}: exit ${String(r.status)}\n${(r.stdout + r.stderr).trim().split('\n').slice(0, 24).join('\n')}`;
    });
    const route = run('route', ['-n', 'get', CANARY_IP]);
    shown.push(
      `$ route -n get ${CANARY_IP}: exit ${String(route.status)}\n${(route.stdout + route.stderr).trim()}`,
    );
    return shown.join('\n');
  };
  return {
    kind: 'pf',
    arm() {
      writeFileSync(rules, pfRules(ips));
      // -E takes a reference ("Token : n") and enables pf when it was off; -X n drops it again.
      // Enable first, then load: what is loaded last is what runs.
      const e = must('pfctl -E', pfctl('-E'));
      token = /Token\s*:\s*(\d+)/.exec(e.stdout + e.stderr)?.[1] ?? null;
      must('pfctl -f', pfctl('-f', rules));
      process.stdout.write(`${describe()}\n`);
    },
    read() {
      return parsePfCounters(must('pfctl -vsr', pfctl('-vsr')).stdout, ips);
    },
    disarm() {
      pfctl('-F', 'rules');
      if (token !== null) pfctl('-X', token);
    },
    describe,
  };
}

function windowsFirewall(scriptsDir: string, ips: readonly string[]): Tripwire {
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
      const r = must('tripwire.ps1 arm', ps('-Action', 'arm', '-Addresses', ips.join(',')));
      process.stdout.write(r.stdout);
      log = /^LOG=(.+)$/m.exec(r.stdout)?.[1]?.trim() ?? '';
      offset = /^OFFSET=(\d+)$/m.exec(r.stdout)?.[1] ?? '0';
      if (log === '') throw new Error('tripwire.ps1 arm did not say where the firewall log is');
    },
    read() {
      const r = must(
        'tripwire.ps1 read',
        ps('-Action', 'read', '-Addresses', ips.join(','), '-Log', log, '-Offset', offset),
      );
      return parseWindowsFirewallLog(r.stdout, ips);
    },
    disarm() {
      ps('-Action', 'disarm');
    },
    describe() {
      return `firewall log ${log} from offset ${offset}`;
    },
  };
}

/** The tripwire for this machine. `work` is a scratch directory, `scriptsDir` is `scripts/pear-ci`. */
export function createTripwire(
  platform: string,
  work: string,
  scriptsDir: string,
  ips: readonly string[] = TRIPWIRE_IPS,
): Tripwire {
  if (!ips.includes(CANARY_IP)) throw new Error('the tripwire must watch its canary');
  switch (platform) {
    case 'linux':
      return iptables(ips);
    case 'darwin':
      return pf(work, ips);
    case 'win32':
      return windowsFirewall(scriptsDir, ips);
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
        `the tripwire (${tw.kind}) did not count the canary datagram in ${String(waitMs)} ms: it counts nothing, so it proves nothing\n${tw.describe()}`,
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * A reading that is complete: sends the canary datagram again and waits until the tripwire counts
 * it, so that everything the tripwire was going to count before that moment has been counted
 * (Windows writes its firewall log some seconds late, and in order). Returns that reading.
 */
export async function barrier(tw: Tripwire, waitMs: number): Promise<Hits> {
  const before = tw.read()[CANARY_IP] ?? 0;
  await sendCanary();
  const until = Date.now() + waitMs;
  for (;;) {
    const now = tw.read();
    if ((now[CANARY_IP] ?? 0) > before) return now;
    if (Date.now() > until)
      throw new Error(
        `the tripwire (${tw.kind}) did not count the barrier datagram in ${String(waitMs)} ms`,
      );
    await new Promise((r) => setTimeout(r, 1000));
  }
}
