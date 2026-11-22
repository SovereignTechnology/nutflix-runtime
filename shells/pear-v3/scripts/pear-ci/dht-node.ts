/**
 * The install job's private DHT: a HyperDHT testnet, ten nodes bound to 127.0.0.1 and told no
 * other bootstrap, so it cannot reach the public network and the public network cannot reach it.
 * Pear's own test runner makes its network the same way (`createTestnet(10)`).
 *
 * It runs as a process of its own because the job's main process spends seconds at a time hashing
 * a bundle, and a DHT that cannot answer for seconds makes `pear install` time out. It prints one
 * line, `BOOTSTRAP 127.0.0.1:<port>`, and runs until its stdin closes (the job going away takes it
 * with it) or it is told to stop.
 *
 *   node dht-node.ts
 */
import createTestnet from 'hyperdht/testnet.js';

const testnet = await createTestnet(10, { host: '127.0.0.1' });
const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${String(b.port)}`);
if (bootstrap.length === 0 || bootstrap.some((b) => !b.startsWith('127.0.0.1:')))
  throw new Error(`the testnet is not on loopback: ${bootstrap.join(',')}`);
process.stdout.write(`BOOTSTRAP ${bootstrap.join(',')}\n`);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void testnet.destroy().finally(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.resume();
