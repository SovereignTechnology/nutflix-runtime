/**
 * The window methods main answers itself (`rpc-gate.ts`, `mainMethods`). Each is something a page
 * must not be able to do alone, so each goes through a native dialog that only the user can
 * answer. Electron-free: `main.ts` passes the dialogs in, the tests pass fakes.
 *
 *   - `app.pickVideo` opens the OS file picker. The path goes straight to the worker
 *     (`studio.source`); the page gets a random token, the base name and the size.
 *   - `app.seeding.set` turns "seed what I watch" on only after a native confirmation that says
 *     what it does. Turning it off needs no question.
 *   - `app.publish.sign` has the user's signer sign Studio's draft, which publishes the video and
 *     starts seeding it, only after a native confirmation that names the title and the key.
 *
 * A "no" is not asked again for a minute, so a page cannot wear the user down with the same box.
 */
import { WorkerError } from '@nutflix-runtime/worker';

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'ts'];

export const PICK_VIDEO_DIALOG = {
  title: 'Choose a video to publish',
  properties: ['openFile' as const],
  filters: [{ name: 'Videos', extensions: VIDEO_EXTENSIONS }],
};

export const CONFIRM_SEEDING_YES = 1;

export const CONFIRM_SEEDING_DIALOG = {
  type: 'warning' as const,
  title: 'Seed what you watch?',
  message: 'Seeding shares your IP address with viewers.',
  detail:
    'While this is on, Nutflix keeps the free videos you watch and serves them to other people. ' +
    'Anyone who fetches one from you can see your IP address, and the Nostr relays you use learn ' +
    'which videos you seed.',
  buttons: ['Keep it off', 'Turn on seeding'],
  defaultId: 0,
  cancelId: 0,
  noLink: true,
};

export const CONFIRM_PUBLISH_YES = 1;
/** How long a question the user answered "no" to stays unasked. */
export const DECLINED_WAIT_MS = 60_000;
/** A bunker may be waiting for its user to approve. */
const SIGN_TIMEOUT_MS = 180_000;
const MAX_SHOWN_TITLE = 120;

/** A title in a system dialog: one line, with no control or text-direction characters. */
export function shownTitle(title: string): string {
  const clean = title.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,
    '',
  );
  return clean.length <= MAX_SHOWN_TITLE ? clean : `${clean.slice(0, MAX_SHOWN_TITLE - 1)}…`;
}

export function publishDialog(
  title: string,
  signer: string,
): {
  type: 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
} {
  return {
    type: 'warning',
    title: 'Publish this video?',
    message: 'Publishing shares your IP address with viewers.',
    detail:
      `Title: ${shownTitle(title)}\nSigned by key: ${signer.slice(0, 16)}…\n\n` +
      'Nutflix will sign this video with your key, announce it on your relays and serve it from ' +
      'this computer. Anyone who fetches it from you can see your IP address.',
    buttons: ['Do not publish', 'Publish and seed'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

/** Until when (ms) each question stays unasked after a "no". Main holds one for the whole run. */
export interface Declined {
  seeding: number;
  publish: number;
}

export interface MainCallDeps {
  /** The native picker: the chosen path, or `null` if the user cancelled. */
  pickFile(): Promise<string | null>;
  /** The native confirmation: `true` only if the user chose to turn it on. */
  confirmSeeding(): Promise<boolean>;
  /** The native confirmation before a signature: `true` only if the user chose to publish. */
  confirmPublish(o: { readonly title: string; readonly signer: string }): Promise<boolean>;
  /** Main's own request to the worker. */
  worker(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  readonly declined: Declined;
  /** Default: the clock. */
  now?(): number;
}

const onlyKeys = (a: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(a).every((k) => keys.includes(k));

export async function answerMainCall(
  method: string,
  args: Record<string, unknown>,
  d: MainCallDeps,
): Promise<unknown> {
  const now = (): number => d.now?.() ?? Date.now();
  switch (method) {
    case 'app.pickVideo': {
      if (!onlyKeys(args, [])) throw new WorkerError('invalid-argument', 'takes no arguments');
      const path = await d.pickFile();
      return path === null ? null : d.worker('studio.source', { path });
    }
    case 'app.seeding.set': {
      const on = args['on'];
      if (!onlyKeys(args, ['on']) || typeof on !== 'boolean')
        throw new WorkerError('invalid-argument', 'on must be true or false');
      if (on) {
        if (now() < d.declined.seeding)
          throw new WorkerError('rate-limited', 'you said no a moment ago: try again in a minute');
        if (!(await d.confirmSeeding())) {
          d.declined.seeding = now() + DECLINED_WAIT_MS;
          return d.worker('seeding.status', {});
        }
      }
      return d.worker('seeding.set', { watched: on });
    }
    case 'app.publish.sign': {
      if (!onlyKeys(args, ['event']) || args['event'] === undefined)
        throw new WorkerError('invalid-argument', 'takes one event');
      if (now() < d.declined.publish)
        throw new WorkerError('rate-limited', 'you said no a moment ago: try again in a minute');
      const event = args['event'];
      // The worker answers only for the exact draft Studio made: what the box shows is that.
      const draft = (await d.worker('signer.check', { event })) as {
        readonly title: string;
        readonly signer: string;
      };
      if (!(await d.confirmPublish({ title: draft.title, signer: draft.signer }))) {
        d.declined.publish = now() + DECLINED_WAIT_MS;
        throw new WorkerError('invalid-argument', 'you chose not to publish it');
      }
      return d.worker('signer.sign', { event }, SIGN_TIMEOUT_MS);
    }
    default:
      throw new WorkerError('invalid-argument', 'method not allowed');
  }
}
