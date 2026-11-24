import { describe, expect, it } from 'vitest';

import { PAGE_PORT_MIN, PAGE_PORT_SPAN, pagePort } from '../bare/page-port.ts';
import {
  BASE_HEADERS,
  answerPageRequest,
  contentType,
  type PageRequest,
} from '../bare/page-server.ts';

const HOST = '127.0.0.1:4567';
const FILES = new Set(['index.html', 'app.js', 'nfx/player.js', 'ui.css']);
const req = (o: Partial<PageRequest> = {}): PageRequest => ({
  method: 'GET',
  url: '/',
  host: HOST,
  xPear: 'Pear abc',
  ...o,
});

describe('the page origin', () => {
  it('serves the page at / and each listed file', () => {
    expect(answerPageRequest(req(), FILES, HOST)).toEqual({
      status: 200,
      file: 'index.html',
      type: 'text/html; charset=utf-8',
      head: false,
    });
    expect(answerPageRequest(req({ url: '/nfx/player.js' }), FILES, HOST)).toMatchObject({
      status: 200,
      file: 'nfx/player.js',
      type: 'text/javascript; charset=utf-8',
    });
  });

  it('ignores a query and answers HEAD with no body', () => {
    expect(answerPageRequest(req({ url: '/app.js?x=1' }), FILES, HOST)).toMatchObject({
      file: 'app.js',
    });
    expect(answerPageRequest(req({ method: 'HEAD' }), FILES, HOST)).toMatchObject({ head: true });
  });

  it.each([
    ['another Host (DNS rebinding)', { host: 'evil.example:4567' }],
    ['localhost as the Host', { host: 'localhost:4567' }],
    ['no Host', { host: undefined }],
    ['no X-Pear', { xPear: undefined }],
    ['a wrong X-Pear', { xPear: 'Bearer x' }],
  ])('refuses %s', (_n, o) => {
    expect(answerPageRequest(req(o), FILES, HOST)).toEqual({ status: 403 });
  });

  it.each(['POST', 'PUT', 'DELETE', 'OPTIONS', undefined])('refuses the method %s', (method) => {
    expect(answerPageRequest(req({ method }), FILES, HOST)).toEqual({ status: 405 });
  });

  it.each([
    '/index.js',
    '/package.json',
    '/worker/keys.js',
    '/node_modules/pear-electron/package.json',
    '/../package.json',
    '/nfx/../../index.js',
    '/%2e%2e/package.json',
    '/app.js/',
    '//app.js',
    '/APP.JS',
  ])('answers 404 for %s', (url) => {
    expect(answerPageRequest(req({ url }), FILES, HOST)).toEqual({ status: 404 });
  });

  it.each(['app.js', 'http://evil.example/app.js', '', undefined])(
    'refuses the request target %j',
    (url) => {
      expect(answerPageRequest(req({ url }), FILES, HOST)).toEqual({ status: 400 });
    },
  );

  it('will not serve a listed file of a kind the page never uses', () => {
    expect(answerPageRequest(req({ url: '/x.sh' }), new Set(['x.sh']), HOST)).toEqual({
      status: 404,
    });
  });

  it('knows the page’s content types, and nothing else', () => {
    expect(contentType('a.wasm')).toBe('application/wasm');
    expect(contentType('a.css')).toBe('text/css; charset=utf-8');
    expect(contentType('a')).toBeNull();
    expect(contentType('a.exe')).toBeNull();
  });

  it('sends nosniff and no-store on every answer', () => {
    expect(BASE_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(BASE_HEADERS['Cache-Control']).toBe('no-store');
    expect(BASE_HEADERS['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });

  it('keeps the script policy out of the header, where it would stop the runtime preload', () => {
    expect(BASE_HEADERS['Content-Security-Policy']).toBe("frame-ancestors 'none'");
  });
});

describe('the page port', () => {
  const key = 'y'.repeat(52);
  const other = 'b'.repeat(52);

  it('is the same for every version of the same app, so its settings survive', () => {
    const p = pagePort(`pear://${key}`);
    expect(pagePort(`pear://0.100.${key}`)).toBe(p);
    expect(pagePort(`pear://0.101.${key}`)).toBe(p);
    expect(pagePort(`pear://2.7.${key}/some/path`)).toBe(p);
  });

  it('differs between apps, and moves on when taken', () => {
    expect(pagePort(`pear://${other}`)).not.toBe(pagePort(`pear://${key}`));
    expect(pagePort(`pear://${key}`, 1)).not.toBe(pagePort(`pear://${key}`, 0));
  });

  it.each([`pear://${'y'.repeat(52)}`, 'file:///x/app', '', 'zzz'])(
    'stays in range for %j',
    (l) => {
      for (let i = 0; i < 40; i++) {
        const p = pagePort(l, i * 997);
        expect(p).toBeGreaterThanOrEqual(PAGE_PORT_MIN);
        expect(p).toBeLessThan(PAGE_PORT_MIN + PAGE_PORT_SPAN);
        expect(Number.isInteger(p)).toBe(true);
      }
    },
  );
});
