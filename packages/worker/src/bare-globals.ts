/**
 * nutflix-pear's `app-desktop/src/worker/bare-globals.ts` (the submodule's pinned commit); `./main.ts`
 * is the entry here. One addition: `crypto.getRandomValues`, which Bare does not have and
 * `nostr-tools` needs to sign (BIP-340 auxiliary randomness) and to encrypt NIP-46 (NIP-44 nonces).
 * It is libsodium's CSPRNG, installed before those modules load.
 *
 * D6, as a module: installs `bare-encoding`'s WHATWG `TextEncoder` / `TextDecoder` as
 * globals — exactly what `bare-encoding/global` does (`global.TextDecoder =
 * encoding.TextDecoder`, `global.TextEncoder = encoding.TextEncoder`), but through the
 * package's typed root export, because importing `bare-encoding/global` from TypeScript also
 * loads its `declare global` block, which redeclares `TextDecoder` for the whole worker
 * project and breaks every Node-typed test that constructs one with options.
 *
 * `./entry.ts` imports this module FIRST; ES modules evaluate in import order, so every
 * later module (`@sovit/core` builds a `TextDecoder` at load) sees the globals. Only ever
 * imported by the Bare entry: Node already has both.
 */
import { TextDecoder, TextEncoder } from 'bare-encoding';
import sodium from 'sodium-native';

const g = globalThis as Record<string, unknown>;
g['TextEncoder'] = TextEncoder;
g['TextDecoder'] = TextDecoder;
g['crypto'] ??= {
  getRandomValues<T extends ArrayBufferView>(array: T): T {
    sodium.randombytes_buf(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  },
};
