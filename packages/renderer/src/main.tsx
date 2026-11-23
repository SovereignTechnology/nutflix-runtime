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
import type { NfxPlayerLib } from './player/nfx-lib.js';
import type { PlayerLoader } from './player/load.js';
import { probeCapabilities, probePlayer, type CapabilityReport, type ProbeEnv } from './probe.js';
import { browserSettingsStore, type SettingsStore } from './settings/store.js';
import { webrtcStatusText } from './settings/webrtc.js';
import { installWebRtcNote } from './settings/webrtc-note.js';
import { SeedPublish } from './seeding/controller.js';
import { installSeedPublishPanel } from './seeding/panel.js';
import { SegmentTap } from './seeding/segment-tap.js';
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
  /**
   * The pinned nfx player library (`player/load.ts`). Absent: the WebRTC player is unavailable,
   * and every video plays from the worker's progressive stream.
   */
  readonly loadPlayer?: PlayerLoader | undefined;
  /** Default: this runtime's own (`probePlayer`). Given: no library is loaded. */
  readonly capabilities?: CapabilityReport | undefined;
}

export interface RendererClient {
  readonly adapter: RuntimeNetworkAdapter;
  readonly settings: SettingsStore;
  /** What the probe has found so far: `probed` resolves with the final answer. */
  readonly capabilities: CapabilityReport;
  /** Resolves when the probe is done (it loads the pinned library). Never rejects. */
  readonly probed: Promise<CapabilityReport>;
  /** Resolves on the worker's first answer through this page's pipe. Asks only when called. */
  workerReady(): Promise<void>;
  /** Unmounts the shell, closes every play and subscription, and stops following the URL. */
  stop(): Promise<void>;
}

export function startRenderer(o: RendererOptions): RendererClient {
  const win = o.window ?? o.container.ownerDocument.defaultView;
  if (win === null) throw new Error('startRenderer: the container is not in a window');
  const env = win as unknown as ProbeEnv;
  // Until the library has loaded, nothing plays through it. The dataset attribute appears only
  // with the final answer, because a shell's launch check reads it as that.
  let capabilities: CapabilityReport = o.capabilities ?? {
    ...probeCapabilities(env),
    player: false,
  };
  let lib: NfxPlayerLib | null = null;
  const settings = o.settings ?? browserSettingsStore(win);
  const pool = o.pool ?? new SimplePoolAdapter();
  const link = new WorkerLink({ pipe: o.pipe });
  // Seeding and publishing (Settings' own section): the worker holds every key and does the work.
  const control = new SeedPublish({ worker: link, pool, settings });
  const tap = new SegmentTap({ worker: link, enabled: () => control.watching });
  tap.install(
    (win as unknown as { SourceBuffer?: { prototype: Parameters<SegmentTap['install']>[0] } })
      .SourceBuffer?.prototype,
  );
  const adapter = new RuntimeNetworkAdapter({
    pool,
    settings,
    worker: link,
    player: () => lib,
    fetch: o.fetch ?? ((input, init) => win.fetch(input, init)),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
    onPlay: (play) => {
      control.onPlay(play);
    },
    onVerified: (sha256, sid) => {
      tap.verified(sha256, sid);
    },
    onPlayEnded: (sid) => {
      tap.ended(sid);
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

  const note = installWebRtcNote(o.container, () =>
    webrtcStatusText(capabilities.reason, settings.get().nfx),
  );
  const offNoteSettings = settings.onChange(() => {
    note.refresh();
  });
  const panel = installSeedPublishPanel(o.container, control);
  // Nothing is asked of the worker at launch: it (or the shell) says when something is served.
  const offServing = control.listen();

  const probed: Promise<CapabilityReport> = (async () => {
    if (o.capabilities === undefined) {
      const r = await probePlayer(env, o.loadPlayer);
      capabilities = r.report;
      lib = r.player?.lib ?? null;
    }
    o.container.dataset['webrtcPlayer'] = capabilities.player ? 'available' : 'unavailable';
    note.refresh();
    return capabilities;
  })();

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
    get capabilities() {
      return capabilities;
    },
    probed,
    workerReady: () => link.ready(),
    stop: () => {
      stopped ??= (async (): Promise<void> => {
        win.removeEventListener('hashchange', onHash);
        unguard();
        offRouter();
        offSettings();
        offNoteSettings();
        note.stop();
        panel.stop();
        offServing();
        control.stop();
        tap.uninstall();
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
