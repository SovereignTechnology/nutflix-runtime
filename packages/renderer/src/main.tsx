/**
 * The renderer's entry: `@sovit/ui`'s shell over `RuntimeNetworkAdapter`, with this app's offer
 * (`RUNTIME_OFFER`) and the route mirrored into the page's hash (`./shell/routes.ts`). Modelled on
 * nutflix-pear's `packages/app-web/src/main.tsx` (the submodule's pinned commit).
 *
 * The worker is reached only through the `WorkerPipe` the shell passes in. Nostr runs here, over
 * the browser's WebSocket: the catalogue, NIP-11-aware search and the live beacon watch are
 * core's own (`NfxCatalog`, `RelaySearchSupport`, `NfxBeaconWatch`).
 */
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell, applyTheme, createShellModel, sameRoute } from '@sovit/ui';
import { SimplePoolAdapter, type PoolLike } from '@sovit/core/nostr';

import { RuntimeNetworkAdapter } from './adapter/adapter.js';
import { installLinkGuard } from './links.js';
import type { FetchFn } from './net/http.js';
import { probeCapabilities, type CapabilityReport, type ProbeEnv } from './probe.js';
import { browserSettingsStore, type SettingsStore } from './settings/store.js';
import { RUNTIME_OFFER } from './shell/offer.js';
import { hashOf, routeFromLocation } from './shell/routes.js';
import { WorkerLink, type WorkerPipe } from './worker/pipe.js';

export interface RendererOptions {
  /** Where the shell renders. */
  readonly container: HTMLElement;
  /** The worker's framed duplex, already `init`ed by the shell. */
  readonly pipe: WorkerPipe;
  /** Hands an `https:` link a viewer clicked to the host (`shell.openExternal`); absent: links do nothing. */
  readonly openLink?: ((url: string) => void) | undefined;
  /** Default: the container's window. */
  readonly window?: Window | undefined;
  /** Default: `SimplePoolAdapter`, the browser's WebSocket. */
  readonly pool?: PoolLike | undefined;
  /** Default: the window's Web Storage (`browserSettingsStore`). */
  readonly settings?: SettingsStore | undefined;
  /** Default: the window's `fetch`. */
  readonly fetch?: FetchFn | undefined;
  /** Default: this runtime's own (`probeCapabilities`). */
  readonly capabilities?: CapabilityReport | undefined;
}

export interface RendererClient {
  readonly adapter: RuntimeNetworkAdapter;
  readonly settings: SettingsStore;
  /** What the probe found. In this version it only reports: every video plays over HyperDHT. */
  readonly capabilities: CapabilityReport;
  /** Unmounts the shell, closes every play and subscription, and stops following the URL. */
  stop(): Promise<void>;
}

export function startRenderer(o: RendererOptions): RendererClient {
  const win = o.window ?? o.container.ownerDocument.defaultView;
  if (win === null) throw new Error('startRenderer: the container is not in a window');
  const capabilities = o.capabilities ?? probeCapabilities(win as unknown as ProbeEnv);
  o.container.dataset['webrtcPlayer'] = capabilities.player ? 'available' : 'unavailable';
  const settings = o.settings ?? browserSettingsStore(win);
  const pool = o.pool ?? new SimplePoolAdapter();
  const link = new WorkerLink({ pipe: o.pipe });
  const adapter = new RuntimeNetworkAdapter({
    pool,
    settings,
    worker: link,
    fetch: o.fetch ?? ((input, init) => win.fetch(input, init)),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
  });
  const model = createShellModel(adapter, routeFromLocation(win.location));
  const unguard = installLinkGuard(win.document, o.openLink);

  // The route into the hash: replaced, not pushed, so the shell's own back and forward stay the
  // only history, and a `?a=` link becomes its `#/watch/…` form.
  const sync = (): void => {
    const hash = hashOf(model.router.current.route);
    if (win.location.hash !== hash || win.location.search !== '') {
      win.history.replaceState(win.history.state as unknown, '', `${win.location.pathname}${hash}`);
    }
  };
  sync();
  const offRouter = model.router.subscribe(sync);
  // A hash the viewer typed or a link they followed.
  const onHash = (): void => {
    const route = routeFromLocation(win.location);
    if (sameRoute(route, model.router.current.route)) sync();
    else model.router.navigate(route);
  };
  win.addEventListener('hashchange', onHash);
  // Another tab's theme (the shell applies this tab's own saves).
  const offSettings = settings.onChange((s) => {
    applyTheme(s.theme);
  });

  const root = createRoot(o.container);
  root.render(
    createElement(Shell, {
      offer: RUNTIME_OFFER,
      adapter: model.adapter,
      coordinator: model.coordinator,
      router: model.router,
    }),
  );

  let stopped: Promise<void> | null = null;
  return {
    adapter,
    settings,
    capabilities,
    stop: () => {
      stopped ??= (async (): Promise<void> => {
        win.removeEventListener('hashchange', onHash);
        unguard();
        offRouter();
        offSettings();
        root.unmount();
        await adapter.close();
        link.dispose();
        settings.close();
        pool.close();
      })();
      return stopped;
    },
  };
}
