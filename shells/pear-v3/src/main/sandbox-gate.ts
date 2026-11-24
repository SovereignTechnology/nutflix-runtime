/**
 * Running without Chromium's sandbox is the user's choice, never the app's (ADR 0001 amendment,
 * item 2). When `--no-sandbox` is on the command line, main shows a native warning BEFORE any
 * window opens: Quit is the default (Enter, Escape and closing the box all quit), "Run anyway" is
 * the choice. "Run anyway" is stored per install, in the user-data directory; while the sandbox
 * is off a banner stays in the window (`main.ts`). The app never adds the switch itself, and the
 * choice has no effect on a launch without it.
 *
 * Where the sandbox cannot start, Chromium aborts before any app code runs, so the AppImage's
 * launcher passes the switch in that one case (`packaging/apprun.ts`) to reach this warning.
 *
 * The decision is pure: Electron's dialog and the filesystem arrive as `deps`, so the tests drive
 * every branch. Two things revoke the choice, and both delete the file (`consent-file.ts`): the
 * `--forget-sandbox-choice` switch, and Settings while the sandbox is off (`app.sandbox.forget`,
 * behind `FORGET_DIALOG`). Then the next start without the sandbox asks again.
 */
import type { Fields } from './log.ts';

export const CONSENT_FILE = 'sandbox-consent.json';
/** The switch that deletes the stored choice, then exits (`main.ts`). */
export const FORGET_SWITCH = 'forget-sandbox-choice';

export interface Consent {
  readonly v: 1;
  readonly choice: 'run-anyway';
  /** When the choice was made (ISO 8601, UTC). Informational. */
  readonly at: string;
}

/** `text` as a stored choice, or `null`: anything but exactly this shape is no choice. */
export function parseConsent(text: string): Consent | null {
  if (text.length > 1024) return null;
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'at,choice,v' || o['v'] !== 1 || o['choice'] !== 'run-anyway') return null;
  const at = o['at'];
  if (typeof at !== 'string' || at.length > 40 || Number.isNaN(Date.parse(at))) return null;
  return { v: 1, choice: 'run-anyway', at };
}

export type SandboxOutcome =
  | { readonly run: true; readonly sandboxed: true }
  | { readonly run: true; readonly sandboxed: false; readonly via: 'stored-choice' | 'asked' }
  | { readonly run: false };

export interface SandboxGateDeps {
  /** `app.commandLine.hasSwitch('no-sandbox')`. */
  readonly noSandbox: boolean;
  readConsent(): Consent | null;
  /** Throws when the choice cannot be stored; the run goes on, and it is asked again next time. */
  writeConsent(c: Consent): void;
  /** The native modal warning. Quit unless the user chose "Run anyway". */
  ask(): 'quit' | 'run-anyway';
  now(): Date;
  log(name: string, fields?: Fields): void;
}

export function sandboxGate(d: SandboxGateDeps): SandboxOutcome {
  if (!d.noSandbox) return { run: true, sandboxed: true };
  if (d.readConsent() !== null) {
    d.log('sandbox-off', { via: 'stored-choice' });
    return { run: true, sandboxed: false, via: 'stored-choice' };
  }
  // Printed before the box opens: a launcher (and CI) can tell the warning from a hang.
  d.log('sandbox-warning', { shown: true });
  if (d.ask() !== 'run-anyway') {
    d.log('sandbox-quit');
    return { run: false };
  }
  try {
    d.writeConsent({ v: 1, choice: 'run-anyway', at: d.now().toISOString() });
    d.log('sandbox-choice-stored');
  } catch {
    d.log('sandbox-choice-not-stored');
  }
  d.log('sandbox-off', { via: 'asked' });
  return { run: true, sandboxed: false, via: 'asked' };
}

/** The wording of the native warning. Plain text: a dialog shows no markup. */
export const WARNING = {
  title: 'Nutflix was started without Chromium’s sandbox',
  message: 'Run without the sandbox?',
  detail:
    'This system does not let the sandbox start, or --no-sandbox is on the command line. On ' +
    'Ubuntu 24.04 and later, the usual cause is AppArmor’s limit on user namespaces.\n\n' +
    'Without the sandbox, a flaw in this app or in anything a stranger publishes (a title, a ' +
    'description, a video) can run code as you.\n\n' +
    'Quit is the safe choice. “Run anyway” is remembered on this install; a banner ' +
    'stays on the window while the sandbox is off. To forget it, use Settings, or start the app ' +
    'with --forget-sandbox-choice.',
  buttons: ['Quit', 'Run anyway'],
} as const;

/** The banner's text (main injects it into the page while the sandbox is off). */
export const BANNER_TEXT =
  'Chromium’s sandbox is OFF. A flaw in this app or in a published video could run code as you.';

/** The answer to `FORGET_DIALOG` that forgets the choice. */
export const FORGET_YES = 1;

/**
 * The native confirmation before Settings forgets the choice (`main-calls.ts`). Keeping the choice
 * is the default (Enter, Escape and closing the box all keep it): a page cannot change anything by
 * opening the box, only the user's click can.
 */
export const FORGET_DIALOG = {
  type: 'question' as const,
  title: 'Forget “Run anyway”?',
  message: 'Warn again at the next start without the sandbox?',
  detail:
    'Nutflix forgets that you chose to run without Chromium’s sandbox. The next time it starts ' +
    'without the sandbox, it warns you again, and Quit is the default.\n\nThis run stays as it ' +
    'is: the sandbox is off until you quit.',
  buttons: ['Keep the choice', 'Forget it'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
};
