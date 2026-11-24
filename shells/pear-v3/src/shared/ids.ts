/**
 * The names the main process and the preloads agree on. The renderer-facing IPC surface is exactly
 * the first four channels: main registers a handler for the two the renderer may send, and the
 * preload listens for the two main sends. The `PROMPT_*` channels belong to main's prompt window
 * alone (`main/prompt-window.ts`). Nothing else crosses (no `invoke`, no `sendSync`, no `remote`).
 */

/** renderer → main: one chunk of the worker pipe (a `Uint8Array`, at most `MAX_PIPE_CHUNK`). */
export const PIPE_WRITE = 'nutflix:pipe:write';
/** main → renderer: bytes the worker sent to this window. */
export const PIPE_DATA = 'nutflix:pipe:data';
/** main → renderer: the pipe is closed (the worker went away, or this window's stream was corrupt). */
export const PIPE_CLOSE = 'nutflix:pipe:close';
/** renderer → main: an `https:` link a viewer clicked (a string; main checks it again). */
export const OPEN_LINK = 'nutflix:link';

/** prompt window → main: the value the user typed, and that they cancelled. */
export const PROMPT_SUBMIT = 'nutflix:prompt:submit';
export const PROMPT_CANCEL = 'nutflix:prompt:cancel';
/** main → prompt window: what to ask, and a line saying why that value did not work. */
export const PROMPT_SHOW = 'nutflix:prompt:show';
export const PROMPT_ERROR = 'nutflix:prompt:error';
/** The longest value a prompt takes (a `bunker://` URI). */
export const MAX_PROMPT_CHARS = 2048;

/** A whole frame: the worker protocol's 1 MiB payload cap and its 4-byte length header. */
export const MAX_PIPE_CHUNK = 1024 * 1024 + 4;

/** The longest link the preload sends (the renderer's own cap, `MAX_LINK_LENGTH`). */
export const MAX_LINK_CHARS = 2048;

/**
 * The AppImage's launcher asks with this whether Chromium's sandbox starts (`packaging/apprun.ts`).
 * A run that reaches main exits 0 at once: no window, no worker, nothing read or written.
 */
export const SANDBOX_PREFLIGHT_SWITCH = 'sandbox-preflight';

/** One line a build prints on stdout once the window and the worker are both up (CI reads it). */
export const READY_PREFIX = 'NUTFLIX_SHELL_READY';
/** Every other line main prints on stdout for CI and for a person reading a terminal. */
export const EVENT_PREFIX = 'NUTFLIX_SHELL';
