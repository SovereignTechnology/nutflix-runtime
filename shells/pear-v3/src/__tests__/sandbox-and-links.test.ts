import { describe, expect, it, vi } from 'vitest';

import { LINK_LIMIT, LINK_WINDOW_MS, LinkOpener, checkedLink } from '../main/external-links.ts';
import {
  BANNER_TEXT,
  WARNING,
  parseConsent,
  sandboxGate,
  type Consent,
  type SandboxGateDeps,
} from '../main/sandbox-gate.ts';

function gateDeps(o: Partial<SandboxGateDeps> & { answer?: 'quit' | 'run-anyway' }): {
  deps: SandboxGateDeps;
  log: string[];
  stored: Consent[];
  asked: () => number;
} {
  const log: string[] = [];
  const stored: Consent[] = [];
  let asked = 0;
  return {
    log,
    stored,
    asked: () => asked,
    deps: {
      noSandbox: true,
      readConsent: () => null,
      writeConsent: (c) => stored.push(c),
      ask: () => {
        asked++;
        return o.answer ?? 'quit';
      },
      now: () => new Date('2026-11-22T10:00:00Z'),
      log: (name) => log.push(name),
      ...o,
    },
  };
}

describe('the --no-sandbox warning (ADR 0001 amendment, item 2)', () => {
  it('asks nothing and runs sandboxed when the switch is absent', () => {
    const g = gateDeps({ noSandbox: false });
    expect(sandboxGate(g.deps)).toEqual({ run: true, sandboxed: true });
    expect(g.asked()).toBe(0);
    expect(g.log).toEqual([]);
  });

  it('warns before anything else and quits unless the user chooses "Run anyway"', () => {
    const g = gateDeps({});
    expect(sandboxGate(g.deps)).toEqual({ run: false });
    expect(g.log).toEqual(['sandbox-warning', 'sandbox-quit']);
    expect(g.stored).toEqual([]);
  });

  it('stores "Run anyway" for this install and runs unsandboxed', () => {
    const g = gateDeps({ answer: 'run-anyway' });
    expect(sandboxGate(g.deps)).toEqual({ run: true, sandboxed: false, via: 'asked' });
    expect(g.stored).toEqual([{ v: 1, choice: 'run-anyway', at: '2026-11-22T10:00:00.000Z' }]);
  });

  it('does not ask again once stored, and still says the sandbox is off', () => {
    const g = gateDeps({
      readConsent: () => ({ v: 1, choice: 'run-anyway', at: '2026-11-22T10:00:00Z' }),
    });
    expect(sandboxGate(g.deps)).toEqual({ run: true, sandboxed: false, via: 'stored-choice' });
    expect(g.asked()).toBe(0);
    expect(g.log).toEqual(['sandbox-off']);
  });

  it('a stored choice has no effect on a launch without the switch', () => {
    const g = gateDeps({
      noSandbox: false,
      readConsent: () => ({ v: 1, choice: 'run-anyway', at: '2026-11-22T10:00:00Z' }),
    });
    expect(sandboxGate(g.deps)).toEqual({ run: true, sandboxed: true });
  });

  it('runs on, and asks again next time, when the choice cannot be stored', () => {
    const g = gateDeps({
      answer: 'run-anyway',
      writeConsent: () => {
        throw new Error('EROFS');
      },
    });
    expect(sandboxGate(g.deps)).toMatchObject({ run: true, sandboxed: false });
    expect(g.log).toContain('sandbox-choice-not-stored');
  });

  it('has Quit first (the default) and the choice second', () => {
    expect(WARNING.buttons).toEqual(['Quit', 'Run anyway']);
    expect(BANNER_TEXT).toMatch(/sandbox is OFF/);
  });

  it.each([
    ['{"v":1,"choice":"run-anyway","at":"2026-11-22T10:00:00Z"}', true],
    ['{"v":2,"choice":"run-anyway","at":"2026-11-22T10:00:00Z"}', false],
    ['{"v":1,"choice":"quit","at":"2026-11-22T10:00:00Z"}', false],
    ['{"v":1,"choice":"run-anyway","at":"not a date"}', false],
    ['{"v":1,"choice":"run-anyway","at":"2026-11-22T10:00:00Z","x":1}', false],
    ['{"v":1,"choice":"run-anyway"}', false],
    ['[]', false],
    ['null', false],
    ['nonsense', false],
    [`{"v":1,"choice":"run-anyway","at":"${'x'.repeat(2000)}"}`, false],
  ])('parses a stored choice strictly: %s', (text, ok) => {
    expect(parseConsent(text) !== null).toBe(ok);
  });
});

describe('external links', () => {
  it.each([
    ['https://example.com/a?b=1#c', 'https://example.com/a?b=1#c'],
    ['https://EXAMPLE.com', 'https://example.com/'],
  ])('opens %s as %s', (raw, href) => {
    expect(checkedLink(raw)).toBe(href);
  });

  it.each([
    'http://example.com/',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'app://nutflix/index.html',
    'data:text/html,x',
    'https://user:pass@example.com/',
    'https://127.0.0.1/',
    'https://localhost/',
    'https://10.0.0.1/',
    'https://192.168.1.1/',
    'https://[::1]/',
    'https://example.com/\u0000',
    `https://example.com/${'a'.repeat(3000)}`,
    '',
    '//example.com',
    '/relative',
    42,
    null,
    undefined,
    { href: 'https://example.com/' },
  ])('refuses %s', (raw) => {
    expect(checkedLink(raw)).toBeUndefined();
  });

  it('opens at most LINK_LIMIT links per window of time, and never throws', () => {
    let t = 0;
    const open = vi.fn();
    const log: string[] = [];
    const o = new LinkOpener({ open, now: () => t, log: (n) => log.push(n) });
    for (let i = 0; i < LINK_LIMIT + 2; i++) o.request('https://example.com/');
    expect(open).toHaveBeenCalledTimes(LINK_LIMIT);
    expect(log.filter((n) => n === 'link-throttled')).toHaveLength(2);
    t += LINK_WINDOW_MS;
    expect(o.request('https://example.com/')).toBe(true);
    expect(o.request('http://example.com/')).toBe(false);
    open.mockImplementation(() => {
      throw new Error('no browser');
    });
    t += LINK_WINDOW_MS;
    expect(o.request('https://example.com/')).toBe(false);
  });
});
