/**
 * The proof's stand-in for a SovTech release line: copies Pear v2.6.5 at its pinned length onto a
 * NEW key, made in this VM and thrown away with it, and serves that key on the PRIVATE loopback
 * DHT only. It reads the source as a client; it never announces or serves anything on the public
 * DHT.
 *
 *   node release-line.ts <source-store> <new-store> <length> <fork> <127.0.0.1:port,…>
 */
import { loopbackNodes, platformRequire } from './platform-modules.ts';

interface Store {
  replicate(c: unknown): unknown;
  close(): Promise<void>;
}
interface Drive {
  readonly key: Uint8Array;
  readonly discoveryKey: Uint8Array;
  readonly core: {
    readonly length: number;
    readonly fork: number;
    update(o: { wait: boolean }): Promise<unknown>;
  };
  ready(): Promise<void>;
  findingPeers(): () => void;
  checkout(length: number): Drive;
  get(path: string): Promise<Uint8Array | null>;
  mirror(
    to: Drive,
    o: { filter: (k: string) => boolean; preload: boolean; prune: boolean },
  ): {
    done(): Promise<unknown>;
    readonly count: { readonly files: number };
  };
  close(): Promise<void>;
}
interface Swarm {
  on(e: 'connection', f: (c: unknown) => void): void;
  join(
    t: Uint8Array,
    o: { client: boolean; server: boolean },
  ): { flushed(): Promise<void>; destroy(): Promise<void> };
  flush(): Promise<void>;
  destroy(): Promise<void>;
}

const Corestore = platformRequire('corestore') as new (dir: string) => Store;
const Hyperdrive = platformRequire('hyperdrive') as new (s: Store, key?: Uint8Array) => Drive;
const Hyperswarm = platformRequire('hyperswarm') as new (o?: { bootstrap: unknown }) => Swarm;
const id = platformRequire('hypercore-id-encoding') as {
  decode(k: string): Uint8Array;
  normalize(k: Uint8Array): string;
};

const UPSTREAM = 'pzcjqmpoo6szkoc4bpkw65ib9ctnrq7b6mneeinbhbheihaq6p6o';
const HOST = 'linux-x64';

const [source, target, lengthArg, forkArg, bootArg] = process.argv.slice(2);
const length = Number(lengthArg);
const fork = Number(forkArg);
const nodes = loopbackNodes(bootArg);
if (source === undefined || target === undefined || !(length > 0))
  throw new Error('usage: release-line <source> <target> <length> <fork> <bootstrap>');

function keep(key: string): boolean {
  const arch = /\/(by-arch|prebuilds)\/([^/]+)/.exec(key);
  return arch === null || arch[2] === HOST;
}

const srcStore = new Corestore(source);
const src = new Hyperdrive(srcStore, id.decode(UPSTREAM));
await src.ready();
// Blocks the pinned install did not need come from the public network, as a client only.
const reader = new Hyperswarm();
reader.on('connection', (c) => srcStore.replicate(c));
reader.join(src.discoveryKey, { client: true, server: false });
const found = src.findingPeers();
void reader.flush().then(found, found);
while (src.core.length < length) {
  await src.core.update({ wait: true });
  if (src.core.length < length) await new Promise((r) => setTimeout(r, 3000));
}
if (src.core.fork !== fork) throw new Error(`the source is on fork ${String(src.core.fork)}`);

const dstStore = new Corestore(target);
const dst = new Hyperdrive(dstStore);
await dst.ready();
const snap = src.checkout(length);
const m = snap.mirror(dst, { filter: keep, preload: false, prune: false });
await m.done();
await snap.close();
await reader.destroy();

const pkg = await dst.get('/package.json');
const version = (JSON.parse(Buffer.from(pkg ?? '{}').toString()) as { version?: string }).version;
const server = new Hyperswarm({ bootstrap: nodes });
server.on('connection', (c) => dstStore.replicate(c));
await server.join(dst.discoveryKey, { client: false, server: true }).flushed();
process.stdout.write(
  `LINE ${JSON.stringify({ key: id.normalize(dst.key), fork: dst.core.fork, length: dst.core.length, files: m.count.files, version })}\n`,
);

const stop = (): void => {
  void server
    .destroy()
    .then(() => dstStore.close())
    .then(() => srcStore.close())
    .finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
