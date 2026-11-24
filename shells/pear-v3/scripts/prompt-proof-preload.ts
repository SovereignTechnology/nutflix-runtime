/**
 * The proof's OTHER window: a page that tries to answer the prompt on its channel, as a compromised
 * app page with a way to send IPC would. Only `prompt-proof-app.ts` loads this. The app's own
 * preload has no such function.
 */
import { contextBridge, ipcRenderer } from 'electron';

import { PROMPT_CANCEL, PROMPT_SUBMIT } from '../src/shared/ids.ts';

contextBridge.exposeInMainWorld('forgePrompt', (value: string) => {
  ipcRenderer.send(PROMPT_SUBMIT, value);
  ipcRenderer.send(PROMPT_CANCEL);
});
