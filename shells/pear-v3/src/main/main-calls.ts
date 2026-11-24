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
 *   - `app.sandbox.forget`: only while this run is without Chromium's sandbox. After a native
 *     confirmation, the stored "Run anyway" is deleted (`sandbox-gate.ts`), so the next start
 *     without the sandbox warns again. It takes no argument, and it can do nothing else: no path,
 *     no other file, nothing that turns a protection off.
 *
 * And one surface no window can call: `account`, from the native Account menu (`account-menu.ts`).
 * It opens main's own prompt window (`prompt-window.ts`), which takes the passphrase or bunker URI
 * and hands it to the worker. Neither enters the page, and no page can open it.
 *
 * One dialog at a time, so a page cannot pile them up or change the signer under one. A "no" is not
 * asked again for a minute, so it cannot wear the user down with the same box.
 */
import { MAX_COMBINING_RUN, WorkerError, type SignerStatusWire } from '@nutflix-runtime/worker';

import type { AccountAction } from './account-menu.ts';
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
/**
 * How long a prompt the user closed stays unopened. Short, because only the user can open one, from
 * the menu, and a slip should not cost them a minute.
 */
export const PROMPT_DECLINED_WAIT_MS = 5_000;
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

/** A run of combining marks past the cap: it could draw over the dialog's other lines. */
const LONG_MARK_RUN = new RegExp(`(\\p{M}{${String(MAX_COMBINING_RUN)}})\\p{M}+`, 'gu');

/**
 * Text as a system dialog may show it: every control, format and line-separator character removed
 * (Unicode Cc, Cf, Zl, Zp), so it cannot draw a line of its own or reorder the text around it, and
 * runs of combining marks cut to `MAX_COMBINING_RUN`.
 * Display only: joiners that emoji and some scripts need are stored and signed as they are.
 */
export function shownText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(LONG_MARK_RUN, '$1');
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
  /** The title the worker recorded; absent for a video stored by the host. */
  readonly title?: string;
  readonly origin: string;
  readonly bytes: number;
}

export function videoDialog(action: 'delete' | 'resume', v: VideoShown): MessageBox {
  const title = v.title === undefined ? 'no title recorded' : shownText(v.title);
  const what = `Title: ${title}\nVideo: ${shownText(v.video)} (${shownText(v.origin)}, ${shownBytes(v.bytes)})`;
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

/** What the Account menu did: the signer's status, or a line for a native box. */
export interface AccountOutcome {
  readonly status: SignerStatusWire | null;
  readonly problem: string | null;
}

export const NO_SANDBOX_KEY_TEXT =
  "Nutflix is running without Chromium's sandbox, so it will not use a sealed key in this run. " +
  'Any key on this computer stays on disk, untouched. Connect a bunker, or restart with the ' +
  'sandbox on.';

export function accountProblemDialog(problem: string): {
  type: 'info';
  title: string;
  message: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  noLink: boolean;
} {
  return {
    type: 'info',
    title: 'Account',
    message: problem,
    buttons: ['OK'],
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
  /** The stored sandbox choice. Absent: `app.sandbox.forget` is refused, as it is with the sandbox on. */
  readonly sandboxChoice?: SandboxChoice;
  /** Default: the clock. */
  now?(): number;
}

/** What `app.sandbox.forget` reaches (`main.ts` passes the real ones). */
export interface SandboxChoice {
  /** This run is without Chromium's sandbox. */
  off(): boolean;
  /** The native confirmation (`FORGET_DIALOG`): `true` only if the user chose to forget. */
  confirmForget(windowId: number): Promise<boolean>;
  /** Deletes the stored choice (none counts as forgotten). Rejects if it could not. */
  forget(): Promise<void>;
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
  #sandboxForgotten = false;

  constructor(d: MainCallDeps) {
    this.#d = d;
  }

  /** The stored sandbox choice was forgotten in this run (`app.sandbox.forget`). */
  get sandboxChoiceForgotten(): boolean {
    return this.#sandboxForgotten;
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

  #notJustDeclined(key: string, again = 'in a minute'): void {
    if (this.#now() < (this.#declined.get(key) ?? 0))
      throw new WorkerError('rate-limited', `you said no a moment ago: try again ${again}`);
  }

  #decline(key: string, waitMs = DECLINED_WAIT_MS): void {
    this.#declined.set(key, this.#now() + waitMs);
  }

  /** From the native Account menu only. Never rejects: what went wrong is for a native box. */
  async account(windowId: number, action: AccountAction): Promise<AccountOutcome> {
    // Locking is never made to wait for a dialog, as turning seeding off is not: a page that keeps
    // a dialog open must not be able to keep the key unlocked.
    if (action === 'lock') {
      try {
        return {
          status: (await this.#d.worker('signer.lock', {})) as SignerStatusWire,
          problem: null,
        };
      } catch (e) {
        return { status: null, problem: promptProblem(e) };
      }
    }
    if (this.#dialogOpen)
      return { status: null, problem: 'Another Nutflix dialog is open. Finish that one first.' };
    this.#dialogOpen = true;
    try {
      return { status: await this.#accountAction(windowId, action), problem: null };
    } catch (e) {
      return { status: null, problem: promptProblem(e) };
    } finally {
      this.#dialogOpen = false;
    }
  }

  async #accountAction(
    windowId: number,
    action: Exclude<AccountAction, 'lock'>,
  ): Promise<SignerStatusWire> {
    const d = this.#d;
    const key = `account:${action}`;
    this.#notJustDeclined(key, 'in a few seconds');
    if (action !== 'connect') {
      const s = (await d.worker('signer.status', {})) as SignerStatusWire;
      if (!s.localAllowed) throw new WorkerError('unsupported-input', NO_SANDBOX_KEY_TEXT);
      if (action === 'create' && s.keyFile)
        throw new WorkerError('exists', 'A key is already sealed on this computer. Use Unlock.');
      if (action === 'unlock' && !s.keyFile)
        throw new WorkerError('no-signer', 'No key is sealed on this computer. Use Create Key.');
    }
    const { done, status } =
      action === 'create'
        ? await this.#secret(windowId, CREATE_KEY_PROMPT, 'signer.local.create', 'passphrase')
        : action === 'unlock'
          ? await this.#secret(windowId, UNLOCK_KEY_PROMPT, 'signer.local.unlock', 'passphrase')
          : await this.#secret(windowId, CONNECT_BUNKER_PROMPT, 'signer.nip46.connect', 'uri');
    if (!done) this.#decline(key, PROMPT_DECLINED_WAIT_MS);
    return status;
  }

  async #run(windowId: number, method: string, args: Record<string, unknown>): Promise<unknown> {
    const d = this.#d;
    switch (method) {
      case 'app.pickVideo': {
        this.#noArgs(args);
        this.#notJustDeclined('pick', 'in a few seconds');
        const path = await d.pickFile(windowId);
        if (path !== null) return d.worker('studio.source', { path });
        // A page cannot hold the picker open by reopening it the moment it closes.
        this.#decline('pick', PROMPT_DECLINED_WAIT_MS);
        return null;
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
        // Titles are not in the bulk status: the box asks for the one it names.
        const { title } = (await d.worker('seeding.title', { video })) as {
          readonly title?: string | null;
        };
        const named = typeof title === 'string' ? { ...v, title } : v;
        if (!(await d.confirmVideo(windowId, action, named))) {
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
      case 'app.sandbox.forget': {
        this.#noArgs(args);
        const s = d.sandboxChoice;
        if (s?.off() !== true)
          throw new WorkerError(
            'invalid-argument',
            'the sandbox is on: there is no choice to forget',
          );
        // Forgotten once is forgotten for this run: nothing is asked again.
        if (this.#sandboxForgotten) return { forgotten: true };
        this.#notJustDeclined('sandbox');
        if (!(await s.confirmForget(windowId))) {
          this.#decline('sandbox');
          return { forgotten: false };
        }
        try {
          await s.forget();
        } catch {
          throw new WorkerError(
            'io',
            'the choice could not be deleted: quit, then start Nutflix with --forget-sandbox-choice',
          );
        }
        this.#sandboxForgotten = true;
        return { forgotten: true };
      }
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
  ): Promise<{ readonly done: boolean; readonly status: SignerStatusWire }> {
    let answer: unknown;
    const done = await this.#d.askSecret(windowId, spec, async (value) => {
      try {
        answer = await this.#d.worker(method, { [field]: value }, KDF_TIMEOUT_MS + SIGN_TIMEOUT_MS);
        return null;
      } catch (e) {
        return promptProblem(e);
      }
    });
    const status = (done ? answer : await this.#d.worker('signer.status', {})) as SignerStatusWire;
    return { done, status };
  }
}
