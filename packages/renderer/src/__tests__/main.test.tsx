/**
 * The renderer's shell (ADR 0001 decision 3): `@sovit/ui`'s shell over the runtime adapter with
 * this app's offer. After nutflix-pear's `packages/app-web/src/__tests__/main.test.tsx` (the
 * submodule's pinned commit). Nothing a viewer can reach needs what the adapter rejects: Shorts,
 * Subscriptions, Library, Studio and Wallet are not in the sidebar and their routes show Home, Home
 * lists the Network and Tags feeds, Settings shows Appearance, Playback, Relays and NFX. A
 * stranger's title and description render as text, and a click on a link never navigates.
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import type { NostrPubkey } from '@sovit/core';
import { FakeRelayPool } from '@sovit/core/nostr';

import { startRenderer, type RendererClient } from '../main.js';
import { SettingsStore } from '../settings/store.js';
import type { WorkerPipe } from '../worker/pipe.js';
import { Key, addrOf, manifest } from './support/nfx.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A pipe to no worker: this suite plays nothing. */
function idlePipe(): WorkerPipe & { readonly written: Uint8Array[] } {
  const written: Uint8Array[] = [];
  return {
    written,
    write: (b) => void written.push(b),
    onData: () => () => undefined,
    onClose: () => () => undefined,
    close: () => undefined,
  };
}

const running: { client: RendererClient; container: HTMLElement }[] = [];
afterEach(async () => {
  for (const { client, container } of running.splice(0)) {
    await act(async () => {
      await client.stop();
    });
    container.remove();
  }
  window.history.replaceState(null, '', '/');
});

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) {
      await new Promise<void>((r) => {
        setTimeout(r, 0);
      });
    }
  });
}

const NOW = Math.floor(Date.now() / 1000);
const TITLE = 'Orbits of Jupiter';

/** A relay holding one free NFX video. */
function world(o: { title?: string; description?: string } = {}): {
  readonly pool: FakeRelayPool;
  readonly addr: string;
} {
  const pool = new FakeRelayPool();
  const creator = new Key();
  pool.store(
    manifest(creator, 'free-video-1', {
      title: o.title ?? TITLE,
      ...(o.description === undefined ? {} : { description: o.description }),
      createdAt: NOW - 3600,
    }),
  );
  return { pool, addr: addrOf(creator, 'free-video-1') };
}

async function start(
  url = '/',
  w = world(),
  openLink?: (u: string) => void,
): Promise<{
  client: RendererClient;
  container: HTMLElement;
  pipe: ReturnType<typeof idlePipe>;
  addr: string;
}> {
  window.history.replaceState(null, '', url);
  const pipe = idlePipe();
  const container = document.createElement('div');
  document.body.appendChild(container);
  let client: RendererClient | undefined;
  act(() => {
    client = startRenderer({
      container,
      pipe,
      pool: w.pool,
      openLink,
      settings: new SettingsStore({ storage: null }),
      fetch: () => Promise.resolve(new Response('', { status: 404 })),
    });
  });
  if (client === undefined) throw new Error('not started');
  running.push({ client, container });
  await flush();
  return { client, container, pipe, addr: w.addr };
}

const navLabels = (c: HTMLElement): (string | null)[] =>
  Array.from(c.querySelectorAll('.nf-shell__sidebar .nf-shell__nav-item')).map(
    (b) => b.textContent,
  );

const route = (c: HTMLElement): string | null =>
  c.querySelector('.nf-shell')?.getAttribute('data-route') ?? null;

async function goHash(hash: string): Promise<void> {
  window.history.replaceState(null, '', hash);
  act(() => {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });
  await flush();
}

describe('the renderer shell', () => {
  it('the sidebar offers Home and Settings only; Home the Network and Tags feeds', async () => {
    const { container, pipe } = await start();
    expect(navLabels(container)).toEqual(['Home', 'Settings']);
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map((t) => t.textContent);
    expect(tabs).toEqual(['Your tags', 'Network']);
    expect(container.textContent).toContain(TITLE);
    expect(container.textContent).not.toContain('Connect signer');
    // Nothing is asked of the worker until a video plays.
    expect(pipe.written).toEqual([]);
  });

  it('the hidden screens’ routes show Home, from a link or from the router', async () => {
    const { container } = await start('/#/wallet');
    expect(route(container)).toBe('home');
    expect(window.location.hash).toBe('#/');
    for (const hash of ['#/studio', '#/shorts', '#/library']) {
      await goHash(hash);
      expect(route(container), hash).toBe('home');
      expect(window.location.hash, hash).toBe('#/');
    }
  });

  it('#/watch/<addr> opens the NFX watch page', async () => {
    const { container, addr } = await start();
    await goHash(`#/watch/${addr}`);
    expect(route(container)).toBe('watch');
    expect(container.querySelector('.nf-watch__title')?.textContent).toBe(TITLE);
  });

  it('Settings: Appearance, Playback, Relays and NFX; the desktop app’s relays; no switch that does nothing here', async () => {
    const { container } = await start('/#/settings');
    expect(route(container)).toBe('settings');
    const headings = Array.from(container.querySelectorAll('h2')).map((h) => h.textContent);
    expect(headings).toEqual(['Appearance', 'Playback and performance', 'Relays', 'NFX network']);
    expect(container.querySelector('[id$="-appearance-remote-images"]')).toBeNull();
    expect(container.querySelector('[id$="-nfx-enabled"]')).toBeNull();
    expect(container.querySelector('[id$="-nfx-iroh-add"]')).toBeNull();
    // Signaling relays belong to the WebRTC player (slice B).
    expect(container.querySelector('[id$="-nfx-mesh-add"]')).toBeNull();
    expect(container.querySelector('[id$="-nfx-mesh-notice"]')).toBeNull();
    expect(container.textContent).toContain('wss://relay.nutflix.xyz');
    expect(container.textContent).toContain('wss://relay.ditto.pub');
  });

  it('the route follows the hash, and the hash the route', async () => {
    const { client, container } = await start();
    await goHash('#/settings');
    expect(route(container)).toBe('settings');
    await goHash(`#/channel/${'ab'.repeat(32) as NostrPubkey}`);
    expect(route(container)).toBe('channel');
    const home = container.querySelector<HTMLButtonElement>(
      '.nf-shell__sidebar .nf-shell__nav-item',
    );
    act(() => {
      home?.click();
    });
    await flush();
    expect(route(container)).toBe('home');
    expect(window.location.hash).toBe('#/');
    expect(client.adapter.platform).toBe('desktop');
  });

  it('reports what the probe found: without WebRTC and MSE, no player, and it says why', async () => {
    const { client, container } = await start();
    // jsdom has no WebRTC and no Media Source Extensions.
    const report = await client.probed;
    expect(report.player).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(['webrtc', 'mse', 'library']));
    expect(report.reason).toMatch(/missing in this runtime/);
    expect(client.capabilities).toBe(report);
    await flush();
    expect(container.dataset['webrtcPlayer']).toBe('unavailable');
  });

  it('stop() unmounts the shell and stops following the hash', async () => {
    const { client, container } = await start();
    await act(async () => {
      await client.stop();
    });
    running.splice(0);
    expect(container.querySelector('.nf-shell')).toBeNull();
    await goHash('#/settings');
    expect(container.querySelector('.nf-shell')).toBeNull();
    await client.stop();
  });
});

describe('a stranger’s words are text, and their links go nowhere on their own', () => {
  const HOSTILE_TITLE = '<img src=x onerror=alert(1)> Jupiter';
  const DESCRIPTION = [
    '<script>alert(2)</script> <svg onload=alert(3)>',
    '[plain http](http://evil.example/a) and [a script](javascript:alert(4)) and [data](data:text/html,x)',
    'and https://good.example/watch?v=1 and [mixed](HTTPS://Good.example/b)',
  ].join('\n\n');

  it('the title and the description render as text: no element, no handler, no script', async () => {
    const w = world({ title: HOSTILE_TITLE, description: DESCRIPTION });
    const { container } = await start('/', w);
    await goHash(`#/watch/${w.addr}`);
    expect(container.querySelector('.nf-watch__title')?.textContent).toBe(HOSTILE_TITLE);
    expect(container.querySelector('img[src="x"]')).toBeNull();
    expect(container.querySelector('svg[onload]')).toBeNull();
    expect(container.querySelector('[onerror]')).toBeNull();
    expect(container.querySelectorAll('script')).toHaveLength(0);
    expect(container.textContent).toContain('<script>alert(2)</script>');
    // An unknown scheme stays text, whatever the markdown says.
    const hrefs = Array.from(container.querySelectorAll('.nf-md a')).map((a) =>
      a.getAttribute('href'),
    );
    expect(hrefs).not.toContain('javascript:alert(4)');
    expect(hrefs.some((h) => h?.startsWith('data:'))).toBe(false);
    expect(container.textContent).toContain('a script');
  });

  it('a click on a link never navigates; only an https link reaches the shell’s opener', async () => {
    const w = world({ description: DESCRIPTION });
    const opened: string[] = [];
    const { container } = await start('/', w, (u) => opened.push(u));
    await goHash(`#/watch/${w.addr}`);
    const anchors = Array.from(container.querySelectorAll<HTMLAnchorElement>('.nf-md a'));
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    for (const a of anchors) {
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => {
        a.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented, a.getAttribute('href') ?? '').toBe(true);
    }
    // The http link is dropped (and logged nowhere); the https ones are normalised and passed on.
    expect(opened).toEqual(['https://good.example/watch?v=1', 'https://good.example/b']);
    expect(window.location.hash).toBe(`#/watch/${w.addr}`);
  });
});
