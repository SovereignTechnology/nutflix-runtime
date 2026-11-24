/**
 * The platform tools' modules, from the S1 harness's lockfile (`spikes/s1-pear-v2`): its overrides
 * hold `hypercore` at v2.6.5's own version, and a store written by a newer one is refused.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const S1_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'spikes',
  's1-pear-v2',
);

export const platformRequire = createRequire(join(S1_DIR, 'package.json'));

export interface DhtNode {
  readonly host: string;
  readonly port: number;
}

/** `host:port,…`, loopback only: these tools must never serve anything on another network. */
export function loopbackNodes(raw: string | undefined): DhtNode[] {
  const nodes = (raw ?? '').split(',').map((t) => {
    const [host, port] = t.split(':');
    return { host: host ?? '', port: Number(port) };
  });
  if (
    nodes.length === 0 ||
    nodes.some((n) => n.host !== '127.0.0.1' || !Number.isInteger(n.port) || n.port < 1)
  )
    throw new Error('the bootstrap must be 127.0.0.1:<port>[,…]');
  return nodes;
}
