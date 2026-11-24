/**
 * The Bare entry (`index.js` of the staged app). The worker's globals come first: ES modules run
 * in import order, and `@sovit/core` builds a `TextDecoder` at load, which Bare does not have
 * until `bare-globals` installs one. `scripts/stage.ts` refuses a bundle where this import is not
 * the first.
 */
import '../../../../packages/worker/src/bare-globals.js';

import { main } from './main.ts';

main().catch((err: unknown) => {
  console.error(
    `nutflix: could not start: ${err instanceof Error ? err.message : 'unknown error'}`,
  );
  Bare.exit(1);
});
