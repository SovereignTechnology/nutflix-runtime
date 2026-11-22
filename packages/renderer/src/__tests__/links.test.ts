/**
 * Remote URLs never reach navigation (ADR 0001 amendment, item 1): the `https:` gate, the worker's
 * loopback media URL, and the click guard, in a DOM.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { externalLink, installLinkGuard, isWorkerMediaUrl } from '../links.js';

describe('externalLink', () => {
  it('passes an https URL on a public name or address, normalised', () => {
    expect(externalLink('https://example.com/a?b=c#d')).toBe('https://example.com/a?b=c#d');
    expect(externalLink('https://Example.COM')).toBe('https://example.com/');
    expect(externalLink('https://sub.example.org:8443/x')).toBe('https://sub.example.org:8443/x');
    expect(externalLink('https://93.184.216.34/')).toBe('https://93.184.216.34/');
    // Just outside the private ranges on either side.
    expect(externalLink('https://172.32.0.1/')).not.toBeNull();
    expect(externalLink('https://100.128.0.1/')).not.toBeNull();
    expect(externalLink('https://100.63.255.254/')).not.toBeNull();
    expect(externalLink('https://[2606:2800:220:1:248:1893:25c8:1946]/')).not.toBeNull();
  });

  it.each([
    ['http', 'http://example.com/'],
    ['javascript', 'javascript:alert(1)'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['blob', 'blob:https://example.com/x'],
    ['file', 'file:///etc/passwd'],
    ['nostr', 'nostr:npub1abc'],
    ['ws', 'wss://relay.example.com'],
    ['hyper', 'hyper://abc'],
    ['protocol-relative', '//example.com/'],
    ['relative', '/a/b'],
    ['no scheme', 'example.com'],
    ['empty', ''],
    ['user-info', 'https://user:pw@example.com/'],
    ['user-info trick', 'https://example.com@evil.example/'],
    ['space', 'https://exa mple.com/'],
    ['leading space', ' https://example.com/'],
    ['newline', 'https://example.com/\nx'],
    ['tab', 'https://exa\tmple.com/'],
    ['backslash', 'https://example.com\\@evil.example/'],
    ['control char', 'https://example.com/\u0000'],
    ['localhost', 'https://localhost/'],
    ['loopback', 'https://127.0.0.1/'],
    ['obfuscated loopback', 'https://0x7f.1/'],
    ['decimal loopback', 'https://2130706433/'],
    ['private', 'https://192.168.1.1/'],
    ['10/8', 'https://10.0.0.5/'],
    ['carrier-grade NAT', 'https://100.127.255.254/'],
    ['carrier-grade NAT, low end', 'https://100.100.100.100/'],
    ['172.16/12', 'https://172.31.0.1/'],
    ['multicast', 'https://224.0.0.1/'],
    ['documentation', 'https://203.0.113.9/'],
    ['link-local', 'https://169.254.169.254/'],
    ['ipv6 loopback', 'https://[::1]/'],
    ['ipv4-mapped', 'https://[::ffff:127.0.0.1]/'],
    ['.local', 'https://printer.local/'],
    ['single label', 'https://intranet/'],
    ['too long', `https://example.com/${'a'.repeat(3000)}`],
  ])('refuses %s', (_name, raw) => {
    expect(externalLink(raw)).toBeNull();
  });

  it('refuses anything that is not a string', () => {
    for (const x of [
      null,
      undefined,
      1,
      {},
      [],
      ['https://example.com/'],
      new URL('https://example.com'),
    ]) {
      expect(externalLink(x)).toBeNull();
    }
  });
});

describe('isWorkerMediaUrl', () => {
  const tok = 'a'.repeat(32);
  const sid = '0123456789abcdef'.repeat(2);
  it('accepts exactly the worker’s progressive URL', () => {
    expect(isWorkerMediaUrl(`http://127.0.0.1:41234/${tok}/${sid}`)).toBe(true);
    expect(isWorkerMediaUrl(`http://127.0.0.1:1/${tok}/${sid}`)).toBe(true);
  });
  it.each([
    ['https', `https://127.0.0.1:41234/${tok}/${sid}`],
    ['another host', `http://127.0.0.2:41234/${tok}/${sid}`],
    ['localhost', `http://localhost:41234/${tok}/${sid}`],
    ['a remote host', `http://example.com:41234/${tok}/${sid}`],
    ['port 0', `http://127.0.0.1:0/${tok}/${sid}`],
    ['no port', `http://127.0.0.1/${tok}/${sid}`],
    ['port too long', `http://127.0.0.1:123456/${tok}/${sid}`],
    ['short token', `http://127.0.0.1:41234/${'a'.repeat(31)}/${sid}`],
    ['upper-case hex', `http://127.0.0.1:41234/${'A'.repeat(32)}/${sid}`],
    ['no sid (the origin form)', `http://127.0.0.1:41234/${tok}`],
    ['a query', `http://127.0.0.1:41234/${tok}/${sid}?x=1`],
    ['a fragment', `http://127.0.0.1:41234/${tok}/${sid}#x`],
    ['a trailing slash', `http://127.0.0.1:41234/${tok}/${sid}/`],
    ['user-info', `http://u@127.0.0.1:41234/${tok}/${sid}`],
    ['a newline', `http://127.0.0.1:41234/${tok}/${sid}\n`],
    ['null', null],
  ])('refuses %s', (_name, raw) => {
    expect(isWorkerMediaUrl(raw)).toBe(false);
  });
});

describe('installLinkGuard', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    document.body.replaceChildren();
  });

  function page(href: string | null): { a: HTMLAnchorElement; inner: HTMLElement } {
    const a = document.createElement('a');
    if (href !== null) a.setAttribute('href', href);
    a.setAttribute('target', '_blank');
    const inner = document.createElement('b');
    inner.textContent = 'a link';
    a.append(inner);
    document.body.append(a);
    return { a, inner };
  }

  /** Dispatches `type` on `el`; true when something cancelled it. */
  function fire(el: Element, type: 'click' | 'auxclick', button = 0): boolean {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  it('cancels every anchor click and hands an https link to the shell', () => {
    const opened: string[] = [];
    off = installLinkGuard(document, (u) => opened.push(u));
    const { inner } = page('https://example.com/watch?v=1');
    expect(fire(inner, 'click')).toBe(true);
    expect(opened).toEqual(['https://example.com/watch?v=1']);
  });

  it.each([
    'http://example.com/',
    'javascript:alert(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'https://127.0.0.1/',
    'https://user@example.com/',
    '/relative',
    '#/watch/x',
    '',
  ])('cancels %j and opens nothing', (href) => {
    const opened: string[] = [];
    off = installLinkGuard(document, (u) => opened.push(u));
    const { a } = page(href);
    expect(fire(a, 'click')).toBe(true);
    expect(opened).toEqual([]);
  });

  it('a middle click is cancelled and opens nothing', () => {
    const opened: string[] = [];
    off = installLinkGuard(document, (u) => opened.push(u));
    const { a } = page('https://example.com/');
    expect(fire(a, 'auxclick', 1)).toBe(true);
    expect(opened).toEqual([]);
  });

  it('with no shell to open links, a link does nothing, still cancelled', () => {
    off = installLinkGuard(document, undefined);
    const { a } = page('https://example.com/');
    expect(fire(a, 'click')).toBe(true);
  });

  it('acts before the page’s own handlers, and a handler that stops propagation cannot skip it', () => {
    const opened: string[] = [];
    off = installLinkGuard(document, (u) => opened.push(u));
    const { a } = page('https://example.com/');
    a.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    expect(fire(a, 'click')).toBe(true);
    expect(opened).toEqual(['https://example.com/']);
  });

  it('leaves clicks outside an anchor alone, and undoes itself', () => {
    const opened: string[] = [];
    const undo = installLinkGuard(document, (u) => opened.push(u));
    const btn = document.createElement('button');
    document.body.append(btn);
    expect(fire(btn, 'click')).toBe(false);
    const { a } = page('https://example.com/');
    undo();
    expect(fire(a, 'click')).toBe(false);
    expect(opened).toEqual([]);
  });

  it('a shell that throws does not break the page', () => {
    off = installLinkGuard(document, () => {
      throw new Error('openExternal failed');
    });
    const { a } = page('https://example.com/');
    expect(fire(a, 'click')).toBe(true);
  });
});
