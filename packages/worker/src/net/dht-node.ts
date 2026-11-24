/**
 * The worker's one HyperDHT node, adapted from nutflix-pear's `app-desktop/src/worker/net/
 * peer-node.ts` (the submodule's pinned commit) and the own-DHT part of its `nfx/watching.ts`.
 * There a `PeerNode` owned a Hyperswarm for the legacy seeder (Corestore replication, `pay/1`),
 * and free NFX play dialed from a DHT node of its own when there was no swarm. This app has no
 * legacy swarm (ADR 0001 §7: no paid Hyperblobs), so what is kept is that node: NFX-12 dials
 * from it (`../nfx/hyperdht-fetcher.ts`) and listens on it (`../nfx/seeding.ts`), each with its
 * own key pair (NFX-12 §1).
 *
 *   - on demand: nothing is sent until a play dials or a stored video needs a listener, so an
 *     app that only opened tells the DHT nothing about this machine (`state` is `idle` until then);
 *   - `bootstrap`: the network's nodes from local configuration, `null` for HyperDHT's public
 *     bootstrap; `ready()` waits (bounded) for the node to bootstrap, so a dial goes ahead anyway;
 *   - `loopbackOnly`: bind the UDP socket to 127.0.0.1, which needs a 127.0.0.1 bootstrap. The
 *     host sets it exactly when every bootstrap is 127.0.0.1 (a network of this machine's own
 *     processes: the tests, the e2e suites, the `pear run` proof). Bound there, the node reaches
 *     nothing off this machine, whatever its bootstrap is connected to, which is what lets it keep
 *     hyperdht's local-address defaults (`./no-local-addresses.ts`). That module reads the address
 *     the socket is really bound to, not this option; `ready()` waits for the bind, so a dial can.
 *     (dht-rpc 6.28 binds both sockets to the host it is given, with no fallback to another.)
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
  /** Called when `state` moves to `starting` or `ready`. */
  readonly onChange?: () => void;
}

export type DhtState = 'idle' | 'starting' | 'ready' | 'closed';

export class DhtNode {
  private readonly o: DhtNodeOptions;
  private readonly log: Logger;
  private node: DHT | null = null;
  private readying: Promise<DHT> | null = null;
  private stateNow: DhtState = 'idle';
  private destroyed = false;

  constructor(o: DhtNodeOptions) {
    this.o = o;
    this.log = o.logger.child({ component: 'dht' });
  }

  get state(): DhtState {
    return this.stateNow;
  }

  /** Whether this node asks for its UDP socket to be bound to 127.0.0.1 (what it got: `dht.address()`). */
  get loopbackOnly(): boolean {
    return this.o.loopbackOnly === true;
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
    this.stateNow = 'starting';
    this.log.info('DHT node started', {
      bootstrap: bootstrap === null ? 'public' : 'configured',
      loopbackOnly,
    });
    this.o.onChange?.();
    return node;
  }

  /** For a listener, which needs the node synchronously: starts it if needed; `null` once closed. */
  forListener(): DHT | null {
    if (this.destroyed) return null;
    void this.ready().catch(() => undefined);
    return this.node;
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
    // Bound first, so that what a dial reads of the socket's address is there to read. A bind
    // that fails leaves no address, and the dial then hides (`./no-local-addresses.ts`).
    await node.bind().catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      node.fullyBootstrapped().catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.o.bootstrapWaitMs ?? BOOTSTRAP_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!this.destroyed) {
      this.stateNow = 'ready';
      this.o.onChange?.();
    }
    return node;
  }
}
