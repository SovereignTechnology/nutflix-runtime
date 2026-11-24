/**
 * The only way to reach secret entry: the native **Account** menu, and shortcuts main catches before
 * the page sees them. A compromised page can draw a box that looks like the real prompt, so the page
 * must not be what opens it. It has no method for that, and the rule the user can hold on to is
 * simple: Nutflix asks for a passphrase or bunker link only after you chose it from the Account menu.
 *
 * Electron-free: `main.ts` builds the menu from this template, and the tests drive it with fakes.
 */
import type { MenuItemConstructorOptions } from 'electron';

export const ACCOUNT_MENU_LABEL = 'Account';

export type AccountAction = 'create' | 'unlock' | 'connect' | 'lock';

export const ACCOUNT_ITEMS: readonly {
  readonly action: AccountAction;
  readonly label: string;
  readonly accelerator: string;
  readonly key: string;
}[] = [
  // Not Shift+U: on Linux, GTK input methods take Ctrl+Shift+U for Unicode entry.
  { action: 'unlock', label: 'Unlock Key…', accelerator: 'CmdOrCtrl+Shift+O', key: 'o' },
  { action: 'create', label: 'Create Key…', accelerator: 'CmdOrCtrl+Shift+K', key: 'k' },
  { action: 'connect', label: 'Connect Bunker…', accelerator: 'CmdOrCtrl+Shift+B', key: 'b' },
  { action: 'lock', label: 'Lock', accelerator: 'CmdOrCtrl+Shift+L', key: 'l' },
];

/**
 * The application menu. On macOS it also holds the standard menus. On Linux and Windows the Account
 * menu is the whole bar: no reload, no DevTools. The accelerators are shown here and handled by
 * `accountShortcut` in `before-input-event`, so a page cannot swallow them.
 */
export function applicationMenu(
  platform: string,
  run: (action: AccountAction) => void,
): MenuItemConstructorOptions[] {
  const account: MenuItemConstructorOptions = {
    label: ACCOUNT_MENU_LABEL,
    submenu: ACCOUNT_ITEMS.map((i) => ({
      label: i.label,
      accelerator: i.accelerator,
      registerAccelerator: false,
      click: () => {
        run(i.action);
      },
    })),
  };
  return platform === 'darwin'
    ? [{ role: 'appMenu' }, { role: 'editMenu' }, account, { role: 'windowMenu' }]
    : [account];
}

/** The part of Electron's `Input` a shortcut is read from. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly shift: boolean;
  readonly control: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly isAutoRepeat: boolean;
}

/** The action a real key press asks for. A page's synthetic key events never reach this. */
export function accountShortcut(i: KeyInput, platform: string): AccountAction | null {
  if (i.type !== 'keyDown' || i.isAutoRepeat || !i.shift || i.alt) return null;
  const modifier = platform === 'darwin' ? i.meta && !i.control : i.control && !i.meta;
  if (!modifier) return null;
  const key = i.key.toLowerCase();
  return ACCOUNT_ITEMS.find((x) => x.key === key)?.action ?? null;
}

interface MenuLike {
  readonly items: readonly {
    readonly label: string;
    readonly submenu?: { readonly items: readonly { readonly label: string }[] } | null;
  }[];
}

/** Whether the menu in place really holds the Account menu and all of its items. */
export function accountMenuPresent(menu: MenuLike | null): boolean {
  const items = menu?.items.find((i) => i.label === ACCOUNT_MENU_LABEL)?.submenu?.items;
  return (
    items?.length === ACCOUNT_ITEMS.length &&
    ACCOUNT_ITEMS.every((x, n) => items[n]?.label === x.label)
  );
}

/**
 * Whether a person can see the menu. `system`: macOS shows it in the system's menu bar, which is not
 * part of the window.
 */
export function menuBarState(
  platform: string,
  win: { isMenuBarVisible(): boolean; isMenuBarAutoHide(): boolean },
): 'visible' | 'hidden' | 'system' {
  if (platform === 'darwin') return 'system';
  return win.isMenuBarVisible() && !win.isMenuBarAutoHide() ? 'visible' : 'hidden';
}

/** How close together two triggers of one action count as one key press. */
export const ACCOUNT_REPEAT_MS = 400;

/**
 * One trigger per press: on macOS a shortcut can reach both the menu and `before-input-event`.
 * `run` never rejects into the caller.
 */
export class AccountRunner {
  readonly #run: (action: AccountAction) => Promise<void>;
  readonly #now: () => number;
  readonly #last = new Map<AccountAction, number>();

  constructor(run: (action: AccountAction) => Promise<void>, now: () => number = Date.now) {
    this.#run = run;
    this.#now = now;
  }

  trigger(action: AccountAction): void {
    const t = this.#now();
    const last = this.#last.get(action);
    if (last !== undefined && t - last < ACCOUNT_REPEAT_MS) return;
    this.#last.set(action, t);
    void this.#run(action).catch(() => undefined);
  }
}

/** The window the Account menu acts for. */
export interface AccountWindow {
  readonly webContents: { readonly id: number };
  isDestroyed(): boolean;
}

export interface AccountWiringDeps<W extends AccountWindow, M> {
  readonly platform: string;
  /** Electron's `Menu`. */
  readonly menu: {
    buildFromTemplate(template: MenuItemConstructorOptions[]): M;
    setApplicationMenu(menu: M): void;
  };
  readonly window: () => W | undefined;
  /** `MainCalls.account`. */
  readonly account: (
    windowId: number,
    action: AccountAction,
  ) => Promise<{ readonly problem: string | null }>;
  /** The page hears only that the signer may have changed. */
  readonly tellPage: () => void;
  /** A native box. */
  readonly showProblem: (win: W, problem: string) => Promise<unknown>;
}

export interface AccountWiring {
  /** Catches the shortcuts on this window, before its page sees them. */
  attach(wc: {
    on(
      event: 'before-input-event',
      listener: (event: { preventDefault(): void }, input: KeyInput) => void,
    ): unknown;
  }): void;
}

/**
 * The whole of the Account menu: the application menu, its shortcuts and what each does. `main.ts`
 * and the Electron proof both call this, so what the proof drives is the code that ships.
 */
export function wireAccountMenu<W extends AccountWindow, M>(
  d: AccountWiringDeps<W, M>,
): AccountWiring {
  const runner = new AccountRunner(async (action) => {
    const win = d.window();
    if (win === undefined || win.isDestroyed()) return;
    const out = await d.account(win.webContents.id, action);
    d.tellPage();
    if (out.problem !== null && !win.isDestroyed()) await d.showProblem(win, out.problem);
  });
  d.menu.setApplicationMenu(
    d.menu.buildFromTemplate(
      applicationMenu(d.platform, (action) => {
        runner.trigger(action);
      }),
    ),
  );
  return {
    attach: (wc) => {
      wc.on('before-input-event', (e, input) => {
        const action = accountShortcut(input, d.platform);
        if (action === null) return;
        e.preventDefault();
        runner.trigger(action);
      });
    },
  };
}
