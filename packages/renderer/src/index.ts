/**
 * @nutflix-runtime/renderer: the Chromium renderer (ADR 0001 decision 3). `startRenderer` renders
 * `@sovit/ui`'s shell over `RuntimeNetworkAdapter`; the shells give it a `WorkerPipe`.
 */
export const PACKAGE = '@nutflix-runtime/renderer' as const;

export { RuntimeAdapterError, type RuntimeErrorCode } from './errors.js';
export { RuntimeNetworkAdapter, type RuntimeAdapterOptions } from './adapter/adapter.js';
export { hyperdhtEndpoints, type HyperdhtEndpoints } from './adapter/endpoints.js';
export { RuntimeNfxSession } from './adapter/session.js';
export { externalLink, installLinkGuard, isWorkerMediaUrl } from './links.js';
export {
  EMPTY_WASM_MODULE,
  probeCapabilities,
  type Capability,
  type CapabilityReport,
  type ProbeEnv,
} from './probe.js';
export { DEFAULT_NFX, DEFAULT_SETTINGS, NFX_NETWORK, SCOPED_RELAY } from './settings/defaults.js';
export { SETTINGS_KEY, SettingsStore, browserSettingsStore } from './settings/store.js';
export { RUNTIME_OFFER } from './shell/offer.js';
export { hashOf, routeFromLocation } from './shell/routes.js';
export { WorkerLink, asWorkerPipe, type PlayWorker, type WorkerPipe } from './worker/pipe.js';
export { startRenderer, type RendererClient, type RendererOptions } from './main.js';
