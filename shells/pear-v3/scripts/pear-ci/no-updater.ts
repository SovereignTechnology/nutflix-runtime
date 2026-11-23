/**
 * Stops a job before it launches a packaged build that would start an updater, because an updater
 * joins the public DHT at launch and a GitHub runner must never do that.
 *
 *   node scripts/pear-ci/no-updater.ts <the packaged app's directory>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { STAGED } from '../../packaging/identity.ts';
import { assertNoUpgradeLink } from '../../packaging/update-root.ts';

const app = process.argv[2];
if (app === undefined) throw new Error('usage: no-updater.ts <app directory>');
assertNoUpgradeLink(readFileSync(join(app, STAGED.updateWorker), 'utf8'));
process.stdout.write('this build has no upgrade link: it starts no updater\n');
