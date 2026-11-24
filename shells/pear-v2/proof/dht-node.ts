/**
 * The proof's private DHT: a HyperDHT testnet of ten nodes on 127.0.0.1 with no other bootstrap,
 * in a process of its own. It prints `BOOTSTRAP 127.0.0.1:<port>` and runs until its stdin closes.
 */
import createTestnet from 'hyperdht/testnet.js';

const testnet = await createTestnet(10, { host: '127.0.0.1' });
const bootstrap = testnet.bootstrap.map((b) => `${b.host}:${String(b.port)}`);
if (bootstrap.length === 0 || bootstrap.some((b) => !b.startsWith('127.0.0.1:')))
  throw new Error('the testnet is not on loopback');
process.stdout.write(`BOOTSTRAP ${bootstrap.join(',')}\n`);

const stop = (): void => {
  void testnet.destroy().finally(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 10_000).unref();
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.on('SIGTERM', stop);
process.stdin.resume();
