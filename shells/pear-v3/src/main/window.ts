/**
 * The one app window. After nutflix-pear's `app-desktop/src/main/window.ts` (the submodule's
 * pinned commit). The security posture is written out as LITERALS in the constructor call, so a
 * reviewer, and `window.test.ts`, can read it: context isolation on, the Chromium sandbox on, no
 * Node in the page, its workers or its subframes, no DevTools. `webSecurity` stays at its default
 * (on) and `webviewTag` at its default (off); neither is mentioned, so neither can be flipped by a
 * typo. The constructor is a parameter (main passes Electron's `BrowserWindow`) so that the tests
 * capture the options without launching Electron.
 */
import type {
  BrowserWindow as ElectronBrowserWindow,
  BrowserWindowConstructorOptions,
} from 'electron';

export type BrowserWindowCtor = new (
  options: BrowserWindowConstructorOptions,
) => ElectronBrowserWindow;

export function createMainWindow(
  BrowserWindow: BrowserWindowCtor,
  preload: string,
): ElectronBrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Nutflix',
    backgroundColor: '#0f0f0f',
    autoHideMenuBar: true,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      devTools: false,
      spellcheck: false,
      safeDialogs: true,
      navigateOnDragDrop: false,
    },
  });
}

/** The WebRTC policy (ADR 0001 decision 5): ICE gathers on the default public interface only. */
export const WEBRTC_IP_POLICY = 'default_public_interface_only' as const;
