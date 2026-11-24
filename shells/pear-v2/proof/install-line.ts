/**
 * Installs the platform from the proof's release line, with the stock `pear-updater-bootstrap`,
 * over the private DHT.
 *
 *   node install-line.ts <key> <pear-dir> <127.0.0.1:port,…>
 */
import { loopbackNodes, platformRequire } from './platform-modules.ts';

const bootstrap = platformRequire('pear-updater-bootstrap') as (
  key: string,
  dir: string,
  o: { bootstrap: unknown },
) => Promise<unknown>;

const [key, dir, boot] = process.argv.slice(2);
if (key === undefined || dir === undefined) throw new Error('usage: install-line <key> <dir> <b>');
await bootstrap(key, dir, { bootstrap: loopbackNodes(boot) });
process.stdout.write('INSTALLED\n');
process.exit(0);
