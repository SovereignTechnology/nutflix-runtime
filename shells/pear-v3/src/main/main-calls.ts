/**
 * The window methods main answers itself (`rpc-gate.ts`, `mainMethods`). Each is something a page
 * must not be able to do alone, so each goes through a surface only the user can answer.
 * Electron-free: `main.ts` passes the dialogs in, the tests pass fakes.
 *
 *   - `app.pickVideo`: the OS file picker. The path goes straight to the worker (`studio.source`);
 *     the page gets a random token, the base name and the size.
 *   - `app.seeding.set`: "seed what I watch" goes on only after a native confirmation. Turning it
 *     off asks nothing and is never held up by another dialog.
 *   - `app.seeding.resume`, `app.seeding.delete`: serving a stopped video again, or deleting a
 *     video's bytes, each after a native confirmation.
 *   - `app.publish.sign`: the user's signer signs Studio's draft, which publishes the video and
 *     starts seeding it, after a native confirmation of what the WORKER says it will sign: the
 *     file, the whole key, the title, the tags and the start of the description. "No" deletes the
 *     draft. The key the user approved goes back with the request, and any other is refused.
 *   - `app.signer.create`, `.unlock`, `.connect`: main's own prompt window (`prompt-window.ts`)
 *     takes the passphrase or bunker URI and hands it to the worker. Neither enters the page.
 *
 * One dialog at a time, so a page cannot pile them up or change the signer under one. A "no" is not
 * asked again for a minute, so it cannot wear the user down with the same box.
 */
import { WorkerError } from '@nutflix-runtime/worker';

import type { PromptSpec } from './prompt-window.ts';

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

export const CONFIRM_YES = 1;
/** How long a question the user answered "no" to stays unasked. */
export const DECLINED_WAIT_MS = 60_000;
/** A bunker may be waiting for its user to approve. */
const SIGN_TIMEOUT_MS = 180_000;
/** Argon2id at its full cost, on a slow machine. */
const KDF_TIMEOUT_MS = 120_000;
const MAX_DESCRIPTION_LINES = 3;
const MAX_DESCRIPTION_LINE = 120;

export const CREATE_KEY_PROMPT: PromptSpec = {
  title: 'Create a signing key',
  message:
    'Nutflix makes a new key on this computer and seals it with this passphrase. It cannot be ' +
    'reset: without the passphrase the key is lost.',
  label: 'Passphrase (at least 8 characters)',
  repeatLabel: 'The same passphrase again',
  submit: 'Create key',
  minChars: 8,
  maxChars: 1024,
};

export const UNLOCK_KEY_PROMPT: PromptSpec = {
  title: 'Unlock your key',
  message: 'Your passphrase stays out of the Nutflix page.',
  label: 'Passphrase',
  submit: 'Unlock',
  minChars: 8,
  maxChars: 1024,
};

export const CONNECT_BUNKER_PROMPT: PromptSpec = {
  title: 'Connect a bunker',
  message:
    'Paste the bunker:// link from your remote signer. It holds a pairing secret, so it stays ' +
    'out of the Nutflix page.',
  label: 'bunker:// link',
  submit: 'Connect',
  minChars: 10,
  maxChars: 2048,
};

/**
 * Text as a system dialog may show it: every control, format and line-separator character removed
 * (Unicode Cc, Cf, Zl, Zp), so it cannot draw a line of its own or reorder the text around it.
 * Display only: joiners that emoji and some scripts need are stored and signed as they are.
 */
export function shownText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
}

function shownBytes(n: number): string {
  if (n < 1024 * 1024) return `${String(Math.ceil(n / 1024))} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

function shownDuration(sec: number): string {
  const s = Math.round(sec);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const two = (x: number): string => String(x).padStart(2, '0');
  return h > 0 ? `${String(h)}:${two(m % 60)}:${two(s % 60)}` : `${String(m)}:${two(s % 60)}`;
}

const graphemes = (s: string): string[] =>
  Array.from(new Intl.Segmenter().segment(s), (x) => x.segment);

/** The description's length and first lines, each one marked so it cannot pose as a field. */
function shownDescription(text: string): string {
  if (text.trim() === '') return 'Description: none';
  const lines = text
    .split(/\r\n|\r|\n|\p{Zl}|\p{Zp}/u)
    .map((l) => shownText(l).trim())
    .filter((l) => l !== '');
  const first = lines.slice(0, MAX_DESCRIPTION_LINES).map((l) => {
    const cut = graphemes(l);
    return `> ${cut.length <= MAX_DESCRIPTION_LINE ? l : `${cut.slice(0, MAX_DESCRIPTION_LINE).join('')}…`}`;
  });
  const more = lines.length > MAX_DESCRIPTION_LINES ? ['> …'] : [];
  return [`Description (${String(graphemes(text).length)} characters):`, ...first, ...more].join(
    '\n',
  );
}

/** What the worker said it will sign (`signer.check`). */
export interface PublishShown {
  readonly video: string;
  readonly event: unknown;
  readonly signer: string;
  readonly npub: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly description: string;
  readonly file: {
    readonly name: string;
    readonly bytes: number;
    readonly durationSec: number;
  };
}

interface MessageBox {
  type: 'warning';
  title: string;
  message: string;
  detail: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
}

/**
 * The file and the key come first, from the worker's own record. What a page could have typed comes
 * after them, so it cannot push them out of sight.
 */
export function publishDialog(s: PublishShown): MessageBox {
  const tags = s.tags.map((t) => `#${shownText(t)}`).join(' ');
  return {
    type: 'warning',
    title: 'Publish this video?',
    message: 'Publishing shares your IP address with viewers.',
    detail: [
      `File: ${shownText(s.file.name)} (${shownBytes(s.file.bytes)}, ${shownDuration(s.file.durationSec)})`,
      `Signed by: ${s.npub}`,
      `Title: ${shownText(s.title)}`,
      `Tags: ${tags === '' ? 'none' : tags}`,
      shownDescription(s.description),
      '',
      'Nutflix will sign this with your key, announce it on your relays and serve it from this ' +
        'computer. Anyone who fetches it from you can see your IP address. If you say no, the ' +
        'encoded copy is deleted.',
    ].join('\n'),
    buttons: ['Do not publish', 'Publish and seed'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
}

export interface VideoShown {
  readonly video: string;
  readonly origin: string;
  readonly bytes: number;
}

export function videoDialog(action: 'delete' | 'resume', v: VideoShown): MessageBox {
  const what = `Video: ${shownText(v.video)} (${shownText(v.origin)}, ${shownBytes(v.bytes)})`;
  return action === 'delete'
    ? {
        type: 'warning',
        title: 'Delete this video?',
        message: 'This deletes the video from this computer.',
        detail: `${what}\n\nIf nobody else seeds it, it can no longer be watched, and its link stays dead even if you publish the file again.`,
        buttons: ['Keep it', 'Delete'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      }
    : {
        type: 'warning',
        title: 'Seed this video again?',
        message: 'Seeding shares your IP address with viewers.',
        detail: `${what}\n\nThis computer will serve it again to anyone who asks.`,
        buttons: ['Keep it stopped', 'Seed it'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      };
}

export interface MainCallDeps {
  /** The native picker: the chosen path, or `null` if the user cancelled. */
  pickFile(windowId: number): Promise<string | null>;
  /** The native confirmation: `true` only if the user chose to turn it on. */
  confirmSeeding(windowId: number): Promise<boolean>;
  /** The native confirmation before a signature: `true` only if the user chose to publish. */
  confirmPublish(windowId: number, shown: PublishShown): Promise<boolean>;
  /** The native confirmation before deleting, or serving again, one video. */
  confirmVideo(windowId: number, action: 'delete' | 'resume', v: VideoShown): Promise<boolean>;
  /**
   * Main's prompt window. Each submitted value goes to `submit`, which answers `null` when done or
   * a line to show. Resolves `false` if the user cancelled.
   */
  askSecret(
    windowId: number,
    spec: PromptSpec,
    submit: (value: string) => Promise<string | null>,
  ): Promise<boolean>;
  /** Main's own request to the worker. */
  worker(method: string, args: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  /** Default: the clock. */
  now?(): number;
}

const onlyKeys = (a: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(a).every((k) => keys.includes(k));

const MAX_VIDEO_ADDRESS = 256;

function videoArg(args: Record<string, unknown>): string {
  const video = args['video'];
  if (
    !onlyKeys(args, ['video']) ||
    typeof video !== 'string' ||
    video.length === 0 ||
    video.length > MAX_VIDEO_ADDRESS
  )
    throw new WorkerError('invalid-argument', 'takes one video address');
  return video;
}

/** A failure in the prompt's own words: the worker's messages are its own, and hold no secret. */
function promptProblem(e: unknown): string {
  if (e instanceof WorkerError) {
    if (e.code === 'invalid-argument') {
      const said = e.message.replace(/^invalid-argument: /, '');
      return said === 'the request failed validation' ? 'That is not valid.' : said;
    }
    return e.message.replace(/^[a-z-]+: /, '');
  }
  return 'That did not work.';
}

export class MainCalls {
  readonly #d: MainCallDeps;
  #dialogOpen = false;
  /** Until when (ms) each question stays unasked after a "no". */
  readonly #declined = new Map<string, number>();

  constructor(d: MainCallDeps) {
    this.#d = d;
  }

  async answer(windowId: number, method: string, args: Record<string, unknown>): Promise<unknown> {
    // Turning seeding off is never made to wait for a dialog.
    if (method === 'app.seeding.set' && onlyKeys(args, ['on']) && args['on'] === false)
      return this.#d.worker('seeding.set', { watched: false });
    if (this.#dialogOpen) throw new WorkerError('rate-limited', 'a dialog is already open');
    this.#dialogOpen = true;
    try {
      return await this.#run(windowId, method, args);
    } finally {
      this.#dialogOpen = false;
    }
  }

  #now(): number {
    return this.#d.now?.() ?? Date.now();
  }

  #notJustDeclined(key: string): void {
    if (this.#now() < (this.#declined.get(key) ?? 0))
      throw new WorkerError('rate-limited', 'you said no a moment ago: try again in a minute');
  }

  #decline(key: string): void {
    this.#declined.set(key, this.#now() + DECLINED_WAIT_MS);
  }

  async #run(windowId: number, method: string, args: Record<string, unknown>): Promise<unknown> {
    const d = this.#d;
    switch (method) {
      case 'app.pickVideo': {
        this.#noArgs(args);
        const path = await d.pickFile(windowId);
        return path === null ? null : d.worker('studio.source', { path });
      }
      case 'app.seeding.set': {
        if (!onlyKeys(args, ['on']) || args['on'] !== true)
          throw new WorkerError('invalid-argument', 'on must be true or false');
        this.#notJustDeclined('seeding');
        if (!(await d.confirmSeeding(windowId))) {
          this.#decline('seeding');
          return d.worker('seeding.status', {});
        }
        return d.worker('seeding.set', { watched: true });
      }
      case 'app.seeding.resume':
      case 'app.seeding.delete': {
        const video = videoArg(args);
        const action = method === 'app.seeding.delete' ? 'delete' : 'resume';
        this.#notJustDeclined(action);
        const status = (await d.worker('seeding.status', {})) as {
          readonly videos: readonly VideoShown[];
        };
        const v = status.videos.find((x) => x.video === video);
        if (v === undefined) throw new WorkerError('not-found', 'no such video');
        if (!(await d.confirmVideo(windowId, action, v))) {
          this.#decline(action);
          return status;
        }
        await d.worker(action === 'delete' ? 'seeding.delete' : 'seeding.resume', { video });
        return d.worker('seeding.status', {});
      }
      case 'app.publish.sign': {
        const video = videoArg(args);
        this.#notJustDeclined('publish');
        // The worker answers only for a draft it made: what the box shows is its own record.
        const shown = (await d.worker('signer.check', { video })) as PublishShown;
        if (!(await d.confirmPublish(windowId, shown))) {
          this.#decline('publish');
          await d.worker('studio.discard', { video });
          return null;
        }
        return d.worker(
          'signer.sign',
          { event: shown.event, signer: shown.signer },
          SIGN_TIMEOUT_MS,
        );
      }
      case 'app.signer.create':
        this.#noArgs(args);
        return this.#secret(windowId, CREATE_KEY_PROMPT, 'signer.local.create', 'passphrase');
      case 'app.signer.unlock':
        this.#noArgs(args);
        return this.#secret(windowId, UNLOCK_KEY_PROMPT, 'signer.local.unlock', 'passphrase');
      case 'app.signer.connect':
        this.#noArgs(args);
        return this.#secret(windowId, CONNECT_BUNKER_PROMPT, 'signer.nip46.connect', 'uri');
      default:
        throw new WorkerError('invalid-argument', 'method not allowed');
    }
  }

  #noArgs(args: Record<string, unknown>): void {
    if (!onlyKeys(args, [])) throw new WorkerError('invalid-argument', 'takes no arguments');
  }

  /** The value goes from main's prompt to the worker. The page only ever gets the status. */
  async #secret(
    windowId: number,
    spec: PromptSpec,
    method: string,
    field: 'passphrase' | 'uri',
  ): Promise<unknown> {
    let answer: unknown;
    const done = await this.#d.askSecret(windowId, spec, async (value) => {
      try {
        answer = await this.#d.worker(method, { [field]: value }, KDF_TIMEOUT_MS + SIGN_TIMEOUT_MS);
        return null;
      } catch (e) {
        return promptProblem(e);
      }
    });
    return done ? answer : this.#d.worker('signer.status', {});
  }
}
