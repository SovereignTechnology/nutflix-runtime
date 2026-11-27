import { describe, expect, it, vi } from 'vitest';

import { LINK_LIMIT, LINK_WINDOW_MS, LinkOpener, checkedLink } from '../main/external-links.ts';
import { FUSE_NOTICE_TEXT, fuseNoticeCode, shouldShowFuseNotice } from '../main/fuse-notice.ts';
import {
  BANNER_TEXT,
  WARNING,
  parseConsent,
  sandboxGate,
  type Consent,
  type SandboxGateDeps,
} from '../main/sandbox-gate.ts';
import { fromMetrics, fromProcStatus } from '../main/sandbox-proof.ts';

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

describe('what the OS is doing to the renderer', () => {
  const status = (mode: number, filters?: number): string =>
    `Name:\tNutflix\nSeccomp:\t${String(mode)}\n${filters === undefined ? '' : `Seccomp_filters:\t${String(filters)}\n`}Speculation_Store_Bypass:\tthread vulnerable\n`;

  it("reads seccomp on Linux: a filter counts only when it is Chromium's, not the browser's too", () => {
    // A desktop: the browser has no filter; the sandbox gave the renderer one.
    expect(fromProcStatus(status(2, 1), status(0, 0))).toBe('enforced');
    expect(fromProcStatus(status(2, 3), status(0, 0))).toBe('enforced');
    // In a container whose runtime filters every process, with the sandbox on top.
    expect(fromProcStatus(status(2, 2), status(2, 1))).toBe('enforced');
    // The same container under --no-sandbox: the renderer has only the container's filter.
    expect(fromProcStatus(status(2, 1), status(2, 1))).toBe('absent');
    expect(fromProcStatus(status(2, 1), status(2, 2))).toBe('absent');
    // --no-sandbox on a desktop, and strict mode, which is not Chromium's.
    expect(fromProcStatus(status(0, 0), status(0, 0))).toBe('absent');
    expect(fromProcStatus(status(1, 0), status(0, 0))).toBe('absent');
  });

  it('with no filter count (before Linux 5.9), trusts a filter only when the browser has none', () => {
    expect(fromProcStatus(status(2), status(0))).toBe('enforced');
    expect(fromProcStatus(status(2), status(2))).toBe('unknown');
    expect(fromProcStatus(status(2, 1), status(2))).toBe('unknown');
    expect(fromProcStatus(status(0), status(2))).toBe('absent');
  });

  it('is unknown when it cannot read a mode', () => {
    expect(fromProcStatus('Seccomp_filters:\t2\n', status(0, 0))).toBe('unknown');
    expect(fromProcStatus('', status(0, 0))).toBe('unknown');
    expect(fromProcStatus(status(2, 1), '')).toBe('unknown');
  });

  it("reads Electron's metrics for that process only", () => {
    const metrics = [{ pid: 1, sandboxed: false }, { pid: 2, sandboxed: true }, { pid: 3 }];
    expect(fromMetrics(metrics, 2)).toBe('enforced');
    expect(fromMetrics(metrics, 1)).toBe('absent');
    expect(fromMetrics(metrics, 3)).toBe('unknown');
    expect(fromMetrics(metrics, 4)).toBe('unknown');
  });
});

describe('the no-FUSE notice', () => {
  it('shows only on an extracted run, once per version', () => {
    expect(shouldShowFuseNotice('1', null, '0.1.0')).toBe(true);
    expect(shouldShowFuseNotice('1', '0.0.9\n', '0.1.0')).toBe(true);
    expect(shouldShowFuseNotice('1', '0.1.0\n', '0.1.0')).toBe(false);
    expect(shouldShowFuseNotice(undefined, null, '0.1.0')).toBe(false);
    expect(shouldShowFuseNotice('0', null, '0.1.0')).toBe(false);
  });

  it('is fixed text set as text, blocks nothing and goes away', () => {
    const code = fuseNoticeCode();
    expect(code).toContain(JSON.stringify(FUSE_NOTICE_TEXT));
    expect(code).toContain('textContent');
    expect(code).not.toMatch(/innerHTML|insertAdjacentHTML|eval|fetch/);
    expect(code).toContain("pointerEvents = 'none'");
    expect(code).toContain('n.remove()');
  });
});
