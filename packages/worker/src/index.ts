/**
 * `@nutflix-runtime/worker` for the host side (a Pear shell, a renderer bridge, tests): the
 * protocol, its framing and the client. Nothing here loads a Bare addon or `@sovit/core`; the
 * worker itself is `./main.ts` (`@nutflix-runtime/worker/main`).
 */
export * from './protocol.js';
export { FrameDecoder, FramingError, MAX_FRAME_BYTES, encodeFrame } from './framing.js';
export type { FramingErrorCode, FramingOptions } from './framing.js';
export { WorkerError, fromWireError, toWireError } from './errors.js';
export { DEFAULT_REQUEST_TIMEOUT_MS, WorkerClient } from './client.js';
export type { WorkerClientOptions } from './client.js';
