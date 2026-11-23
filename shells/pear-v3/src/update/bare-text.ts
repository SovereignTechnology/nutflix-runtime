/**
 * Bare has no `TextEncoder`/`TextDecoder` globals, and `nostr-tools` builds both when it loads. The
 * updater's entry imports this module FIRST, as the worker does (`packages/worker/src/bare-globals.ts`).
 */
import { TextDecoder, TextEncoder } from 'bare-encoding';

const g = globalThis as Record<string, unknown>;
g['TextEncoder'] = TextEncoder;
g['TextDecoder'] = TextDecoder;
