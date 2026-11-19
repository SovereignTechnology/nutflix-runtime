/**
 * The worker's one HyperDHT node, adapted from nutflix-pear's `app-desktop/src/worker/net/
 * peer-node.ts` (the submodule's pinned commit) and the own-DHT part of its `nfx/watching.ts`.
 * There a `PeerNode` owned a Hyperswarm for the legacy seeder (Corestore replication, `pay/1`),
 * and free NFX play dialed from a DHT node of its own when there was no swarm. This app has no
 * legacy swarm (ADR 0001 §7: no paid Hyperblobs), so what is kept is that node: NFX-12 dials
 * from it (`../nfx/hyperdht-fetcher.ts`) and listens on it (`../nfx/seeding.ts`), each with its
 * own key pair (NFX-12 §1).
 *
 *   - `bootstrap`: the network's nodes from local configuration, `null` for HyperDHT's public
 *     bootstrap; the node starts at once and `ready()` waits (bounded) for it to bootstrap, so a
 *     dial that comes first goes ahead anyway;
 *   - `loopbackOnly` (dev and tests only, as peer-node's): bind the UDP socket to 127.0.0.1,
 *     which needs a 127.0.0.1 bootstrap. Never in production: a loopback-bound node cannot reach
 *     a peer's LAN addresses, which HyperDHT tries for peers behind the same address.
 */
import type { Logger } from '@sovit/seeder';
import DHT from 'hyperdht';

import type { BootstrapNode } from '../protocol.js';

/** How long `ready()` waits for the node to bootstrap before it answers anyway. */
export const BOOTSTRAP_WAIT_MS = 15_000;

export interface DhtNodeOptions {
  /** `null` = HyperDHT's public bootstrap. */
  readonly bootstrap: readonly BootstrapNode[] | null;
  readonly logger: Logger;
  /** Bind the DHT's UDP socket to 127.0.0.1 only (dev / tests). */
  readonly loopbackOnly?: boolean;
  /** Tests: `BOOTSTRAP_WAIT_MS`. */
  readonly bootstrapWaitMs?: number;
}

export type DhtState = 'starting' | 'ready' | 'closed';

export class DhtNode {
  private readonly o: DhtNodeOptions;
  private readonly log: Logger;
  private node: DHT | null = null;
  private readying: Promise<DHT> | null = null;
  private stateNow: DhtState = 'starting';
  private destroyed = false;

  constructor(o: DhtNodeOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'dht' });
  }

  get state(): DhtState {
    return this.stateNow;
  }

  /** The node while started (listeners need it synchronously); else `null`. */
  get dht(): DHT | null {
    return this.destroyed ? null : this.node;
  }

  /** Create the node (once). Throws on a loopback-only node without a loopback bootstrap. */
  start(): DHT {
    if (this.destroyed) throw new Error('backend-down: the DHT node is closed');
    if (this.node !== null) return this.node;
    const { bootstrap, loopbackOnly = false } = this.o;
    if (loopbackOnly && (bootstrap === null || bootstrap.some((b) => b.host !== '127.0.0.1')))
      throw new Error('invalid-argument: a loopback-only node needs a 127.0.0.1 bootstrap');
    const node = new DHT({
      ...(bootstrap === null ? {} : { bootstrap }),
      ...(loopbackOnly ? { host: '127.0.0.1' } : {}),
    });
    this.node = node;
    this.log.info('DHT node started', {
      bootstrap: bootstrap === null ? 'public' : 'configured',
      loopbackOnly,
    });
    return node;
  }

  /**
   * The node, once it bootstrapped or `bootstrapWaitMs` ran out (a dial then goes ahead
   * anyway: HyperDHT keeps bootstrapping). Starts it if needed.
   */
  ready(): Promise<DHT> {
    if (this.destroyed) return Promise.reject(new Error('backend-down: the DHT node is closed'));
    this.readying ??= this.bootstrap(this.start());
    return this.readying;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stateNow = 'closed';
    const node = this.node;
    this.node = null;
    if (node !== null) await node.destroy();
  }

  private async bootstrap(node: DHT): Promise<DHT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      node.fullyBootstrapped().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.o.bootstrapWaitMs ?? BOOTSTRAP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!this.destroyed) this.stateNow = 'ready';
    return node;
  }
}
