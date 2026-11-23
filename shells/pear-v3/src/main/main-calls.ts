/**
 * The two window methods main answers itself (`rpc-gate.ts`, `mainMethods`). Both are things a page
 * must not be able to do alone, so each goes through a native dialog that only the user can
 * answer. Electron-free: `main.ts` passes the dialogs in, the tests pass fakes.
 *
 *   - `app.pickVideo` opens the OS file picker. The path goes straight to the worker
 *     (`studio.source`); the page gets a random token, the base name and the size.
 *   - `app.seeding.set` turns "seed what I watch" on only after a native confirmation that says
 *     what it does. Turning it off needs no question.
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

export interface MainCallDeps {
  /** The native picker: the chosen path, or `null` if the user cancelled. */
  pickFile(): Promise<string | null>;
  /** The native confirmation: `true` only if the user chose to turn it on. */
  confirmSeeding(): Promise<boolean>;
  /** Main's own request to the worker. */
  worker(method: string, args: Record<string, unknown>): Promise<unknown>;
}

const onlyKeys = (a: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(a).every((k) => keys.includes(k));

export async function answerMainCall(
  method: string,
  args: Record<string, unknown>,
  d: MainCallDeps,
): Promise<unknown> {
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
      if (on && !(await d.confirmSeeding())) return d.worker('seeding.status', {});
      return d.worker('seeding.set', { watched: on });
    }
    default:
      throw new WorkerError('invalid-argument', 'method not allowed');
  }
}
