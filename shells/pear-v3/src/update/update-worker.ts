/**
 * The updater process: a Bare process of its own (`pear-runtime`'s `run()`), started by main only
 * when this build was packaged with an upgrade link. It owns the updater and the gate (`gate.ts`),
 * and nothing else runs in it.
 *
 * It builds `pear-runtime-updater`, its store and its swarm itself, the three things a `PearRuntime`
 * wraps. Under Bare, `pear-runtime` also loads `bare-worker`, whose `bare-thread` needs Bare 1.33
 * or later; the shipped `bare-sidecar` is Bare 1.31.
 *
 * Why here: not the renderer (untrusted), not main (the updater replicates data from strangers,
 * and main holds every privilege the app has), and not the data worker (it parses strangers'
 * video and serves the renderer's RPC, so a bug there must not reach `applyUpdate()`). The page
 * has no path to this process: main reads its status frames and passes on a checked copy.
 *
 * The trust root is the constant below, compiled in at package time. This file reads no
 * environment, no argument and no file for it.
 *
 * Wire (`Bare.IPC`, the worker's 4-byte framing): main sends one `{op:'start', …}`; this process
 * sends `{op:'status', status}`.
 */
import './bare-text.ts';

import { FrameDecoder, encodeFrame } from '@nutflix-runtime/worker';
import { hideLocalAddressesOn } from '@nutflix-runtime/worker/no-local-addresses';
import fs from 'bare-fs';
import path from 'bare-path';
import { Socket as WebSocket } from 'bare-ws';
import Corestore from 'corestore';
import DHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import PearRuntimeUpdater from 'pear-runtime-updater';
import sodium from 'sodium-native';

import { UpdateGate, artifactName } from './gate.ts';
import { artifactDigest, type HashFs, type Sha256Factory } from './hash.ts';
import { parseFloor, type Floor } from './notice.ts';
import { MAX_RELAY_MESSAGE_BYTES, fetchNotices, type RelayConnect } from './relays.ts';
import { decodeBakedRoot, type TrustRoot } from './root.ts';
import { parseUpdateStart, type UpdateStart, type UpdateStatus } from './status.ts';

/** Replaced by the bundler (`packaging/stage.ts`) with the root this build was packaged with. */
declare const __NUTFLIX_UPDATE_ROOT__: string;

const EXIT_NO_IPC = 10;
const EXIT_BAD_ROOT = 11;
const EXIT_BAD_START = 12;
const HANDSHAKE_MS = 8_000;
const MAX_START_FRAME = 16 * 1024;

const toHex = (b: Uint8Array): string => {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
};

const sha256: Sha256Factory = () => {
  const state = new Uint8Array(sodium.crypto_hash_sha256_STATEBYTES);
  sodium.crypto_hash_sha256_init(state);
  return {
    update: (bytes) => {
      sodium.crypto_hash_sha256_update(state, bytes);
    },
    digestHex: () => {
      const out = new Uint8Array(sodium.crypto_hash_sha256_BYTES);
      sodium.crypto_hash_sha256_final(state, out);
      return toHex(out);
    },
  };
};

const hashFs: HashFs = {
  lstat: (p) => fs.promises.lstat(p),
  readdir: async (p) => await fs.promises.readdir(p),
  readlink: (p) => fs.promises.readlink(p, 'utf8'),
  read: (p) => fs.createReadStream(p) as AsyncIterable<Uint8Array>,
  join: (a, b) => path.join(a, b),
};

/** A relay URL of the root, already checked by its parser, as what `bare-ws` connects to. */
function relayTarget(url: string): { secure: boolean; host: string; port: number } {
  const m = /^(wss?):\/\/([^:/]+)(?::([0-9]+))?$/.exec(url);
  if (m === null) throw new Error('not a relay origin');
  const [, scheme, host, port] = m;
  const secure = scheme === 'wss';
  return {
    secure,
    host: host ?? '',
    port: port === undefined ? (secure ? 443 : 80) : Number(port),
  };
}

/** A `127.0.0.1:<port>` node of a test root, already checked by its parser. */
function dhtNode(node: string): { host: string; port: number } {
  const [host = '', port = ''] = node.split(':');
  return { host, port: Number(port) };
}

const connect: RelayConnect = (url) => {
  const t = relayTarget(url);
  const ws = new WebSocket({
    ...t,
    path: '/',
    maxPayload: MAX_RELAY_MESSAGE_BYTES,
    handshakeTimeout: HANDSHAKE_MS,
  });
  const text = new TextDecoder();
  return {
    onMessage: (cb) => {
      ws.on('data', (d: unknown) => {
        if (d instanceof Uint8Array) cb(text.decode(d));
      });
    },
    onEnd: (cb) => {
      ws.on('close', cb);
      ws.on('error', cb);
    },
    send: (s) => {
      ws.write(s);
    },
    destroy: () => {
      ws.destroy();
    },
  };
};

async function run(
  root: TrustRoot,
  start: UpdateStart,
  send: (s: UpdateStatus) => void,
): Promise<() => Promise<void>> {
  if (root.upgrade === null) return () => Promise.resolve();
  await fs.promises.mkdir(start.dir, { recursive: true });
  const floorFile = path.join(start.dir, 'notice-floor.json');

  const store = new Corestore(path.join(start.dir, 'pear-runtime', 'corestore'));
  await store.ready();
  const updater = new PearRuntimeUpdater({
    dir: start.dir,
    app: start.app,
    updates: true,
    version: start.version,
    upgrade: root.upgrade,
    name: start.name,
    store,
    ...(root.delayMs === null ? {} : { delay: root.delayMs }),
  });

  const gate = new UpdateGate({
    root,
    updater,
    host: start.host,
    name: start.name,
    artifact: artifactName(start.host, start.name),
    proof: start.name.endsWith('.msix') ? 'msix-deployed' : 'sha256',
    hash: (p) => artifactDigest(hashFs, sha256, p),
    fetchNotices: () => fetchNotices(root, connect),
    readFloor: async (): Promise<Floor | null> => {
      try {
        return parseFloor(JSON.parse(await fs.promises.readFile(floorFile, 'utf8')));
      } catch {
        return null;
      }
    },
    writeFloor: async (floor) => {
      const tmp = `${floorFile}.tmp`;
      await fs.promises.writeFile(tmp, `${JSON.stringify({ v: 1, ...floor })}\n`);
      await fs.promises.rename(tmp, floorFile);
    },
    now: () => Date.now(),
    status: send,
    join: (...parts) => path.join(...parts),
    basename: (p) => path.basename(p),
  });

  updater.on('updated', () => {
    void gate.onUpdated();
  });
  updater.on('error', () => {
    send({ state: 'watching', reason: 'updater-error' });
  });
  await updater.ready();
  // No local addresses to the drive's peers (`packages/worker/src/net/no-local-addresses.ts`): left
  // to hyperdht's defaults, anyone announcing on this public drive's topic would get every local
  // IPv4 address of this machine. A test build's private DHT (`root.dht`: 127.0.0.1 nodes only, and
  // refused in a release root, so no release and no run-time input reaches this) keeps the swarm's
  // own node and its defaults: its peer is Pear's sidecar on this machine, bound to every
  // interface, and on one host hyperdht carries data only between peers that share their local
  // addresses and bind alike (measured; see that file).
  // A client of this one drive: it announces nothing and serves no topic of its own.
  const swarm = new Hyperswarm({
    keyPair: await store.createKeyPair('pear-runtime'),
    ...(root.dht === null
      ? { dht: hideLocalAddressesOn(new DHT()) }
      : { bootstrap: root.dht.map(dhtNode) }),
  });
  swarm.on('connection', (connection) => {
    store.replicate(connection);
  });
  swarm.join(updater.drive.core.discoveryKey, { client: true, server: false });
  send({ state: 'watching' });
  return async () => {
    await swarm.destroy();
    await updater.close();
    await store.close();
  };
}

const ipc = Bare.IPC;
if (ipc === null) {
  Bare.exit(EXIT_NO_IPC);
} else {
  let root: TrustRoot;
  try {
    root = decodeBakedRoot(__NUTFLIX_UPDATE_ROOT__);
  } catch {
    Bare.exit(EXIT_BAD_ROOT);
  }
  const send = (status: UpdateStatus): void => {
    try {
      ipc.write(encodeFrame({ op: 'status', status }));
    } catch {
      // Main is gone: the pipe's end stops this process.
    }
  };
  let stop: (() => Promise<void>) | null = null;
  let started = false;
  const decoder = new FrameDecoder(
    (msg) => {
      if (started) return;
      started = true;
      const m = msg as Record<string, unknown>;
      const start = m['op'] === 'start' ? parseUpdateStart(m['start']) : null;
      if (start === null) {
        Bare.exit(EXIT_BAD_START);
        return;
      }
      void run(root, start, send).then(
        (s) => {
          stop = s;
        },
        () => {
          send({ state: 'failed', reason: 'error' });
        },
      );
    },
    { maxFrameBytes: MAX_START_FRAME },
  );
  let ending = false;
  const end = (): void => {
    if (ending) return;
    ending = true;
    const force = setTimeout(() => {
      Bare.exit(0);
    }, 5_000);
    void (stop?.() ?? Promise.resolve())
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(force);
        Bare.exit(0);
      });
  };
  Bare.on('uncaughtException', () => {
    send({ state: 'failed', reason: 'error' });
    Bare.exit(1);
  });
  // Replication libraries can reject on a dropped peer; that decides nothing about an update.
  Bare.on('unhandledRejection', () => {
    send({ state: 'watching', reason: 'updater-error' });
  });
  ipc.on('data', (chunk) => {
    try {
      decoder.push(chunk);
    } catch {
      Bare.exit(EXIT_BAD_START);
    }
  });
  ipc.on('end', end);
  ipc.on('close', end);
  ipc.on('error', end);
}
