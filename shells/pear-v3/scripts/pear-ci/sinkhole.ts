/**
 * No GitHub runner may talk to a public Nostr relay or STUN server, and the packaged app's renderer
 * connects to its default relays as soon as it loads. The app takes no test switch, so the runner's
 * own name resolution is what stops it: every public relay or STUN host the app's sources can name
 * is pointed at loopback in the OS hosts file, before the first launch. Nothing then leaves the
 * machine, and the install job's tripwire counts the real addresses to prove it.
 *
 * The list is READ from the sources (`publicHosts`), so a default added later is covered without
 * anyone remembering this file.
 *
 *   node scripts/pear-ci/sinkhole.ts     blackholes the names on this runner, and proves it
 */
import { spawnSync } from 'node:child_process';
import { lookup, resolve4 } from 'node:dns/promises';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST =
  /\b(?:wss|ws|stuns?|turns?):(?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi;

/** The hosts named in `text`: public names only (no loopback, no reserved documentation names). */
export function hostsIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(HOST)) {
    const h = (m[1] ?? '').toLowerCase();
    if (h === '' || /^[0-9.]+$/.test(h)) continue;
    if (/(^|\.)(example|invalid|test|localhost)$/.test(h)) continue;
    if (/(^|\.)example\.(com|org|net)$/.test(h)) continue;
    out.add(h);
  }
  return [...out].sort();
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : sources(p);
    return /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Every public relay or STUN host in the renderer's sources and the release trust root. */
export function publicHosts(repoRoot: string): string[] {
  const files = [
    ...sources(join(repoRoot, 'packages', 'renderer', 'src')),
    join(repoRoot, 'shells', 'pear-v3', 'packaging', 'update-root.ts'),
  ];
  return [...new Set(files.flatMap((f) => hostsIn(readFileSync(f, 'utf8'))))].sort();
}

/** The real IPv4 addresses of `hosts`, before they are blackholed (for the tripwire to watch). */
export async function resolvePublicIps(hosts: readonly string[]): Promise<string[]> {
  const found = await Promise.all(hosts.map((h) => resolve4(h).catch(() => [] as string[])));
  return [...new Set(found.flat())].sort();
}

export function hostsFile(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== 'win32') return '/etc/hosts';
  return join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}

/** The lines added: each host to both loopbacks, so that neither address family looks further. */
export function sinkholeLines(hosts: readonly string[]): string {
  return `\n# nutflix-ci-sinkhole\n${hosts.map((h) => `127.0.0.1 ${h}\n::1 ${h}\n`).join('')}`;
}

export function applySinkhole(platform: string, hosts: readonly string[]): void {
  const text = sinkholeLines(hosts);
  const file = hostsFile(platform);
  if (platform === 'win32') {
    appendFileSync(file, text.replaceAll('\n', '\r\n'));
    spawnSync('ipconfig', ['/flushdns'], { stdio: 'ignore' });
    return;
  }
  const r = spawnSync('sudo', ['-n', 'tee', '-a', file], {
    input: text,
    stdio: ['pipe', 'ignore', 'pipe'],
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`sudo tee -a ${file}: exit ${String(r.status)} ${r.stderr}`);
  if (platform === 'darwin') {
    spawnSync('sudo', ['-n', 'dscacheutil', '-flushcache'], { stdio: 'ignore' });
    spawnSync('sudo', ['-n', 'killall', '-HUP', 'mDNSResponder'], { stdio: 'ignore' });
  }
}

/** Throws unless the system resolver now answers loopback, and only loopback, for every host. */
export async function assertSinkholed(hosts: readonly string[]): Promise<void> {
  for (const h of hosts) {
    let last = '';
    for (let attempt = 0; attempt < 20; attempt++) {
      const all = await lookup(h, { all: true }).catch(() => []);
      last = all.map((a) => a.address).join(',');
      if (all.length > 0 && all.every((a) => a.address === '127.0.0.1' || a.address === '::1'))
        break;
      last = `not loopback: ${last}`;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (last.startsWith('not loopback') || last === '')
      throw new Error(`${h} still resolves elsewhere (${last})`);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const hosts = publicHosts(root);
  applySinkhole(process.platform, hosts);
  await assertSinkholed(hosts);
  process.stdout.write(`sinkholed ${String(hosts.length)} public hosts: ${hosts.join(' ')}\n`);
}
