/**
 * Whether the OS is really confining the renderer, read from outside it. The absence of
 * `--no-sandbox` is what the app asked for; this is what it got. Pure, so the tests drive every
 * answer.
 *
 * Linux: Chromium's sandbox puts the renderer under a seccomp-bpf filter of its own. A filter alone
 * proves nothing: a container runtime (Docker's default profile), a systemd unit or another sandbox
 * can put one on the whole app, and the renderer inherits it under `--no-sandbox` too. So only a
 * filter the browser process does not have counts: the renderer must carry more filters than the
 * browser (`Seccomp_filters`, Linux 5.9 and later). With no count to compare, a filtered renderer
 * counts only when the browser has no filter at all, and is `unknown` when both have one.
 *
 * macOS and Windows: the `sandboxed` field of Electron's process metrics.
 */
export type RendererSandbox = 'enforced' | 'absent' | 'unknown';

interface Seccomp {
  readonly mode: string;
  readonly filters: number | null;
}

/** `Seccomp` and `Seccomp_filters` of one `/proc/<pid>/status`, or `null` with no mode. */
function seccomp(status: string): Seccomp | null {
  const mode = /^Seccomp:\s*(\d+)\s*$/m.exec(status)?.[1];
  if (mode === undefined) return null;
  const filters = /^Seccomp_filters:\s*(\d+)\s*$/m.exec(status)?.[1];
  return { mode, filters: filters === undefined ? null : Number(filters) };
}

/** From the renderer's `/proc/<pid>/status` and the browser process's own (`/proc/self/status`). */
export function fromProcStatus(renderer: string, browser: string): RendererSandbox {
  const r = seccomp(renderer);
  if (r === null) return 'unknown';
  if (r.mode !== '2') return 'absent';
  const b = seccomp(browser);
  if (b === null) return 'unknown';
  if (r.filters !== null && b.filters !== null)
    return r.filters > b.filters ? 'enforced' : 'absent';
  return b.mode === '0' ? 'enforced' : 'unknown';
}

export function fromMetrics(
  metrics: readonly { readonly pid: number; readonly sandboxed?: boolean }[],
  pid: number,
): RendererSandbox {
  const s = metrics.find((m) => m.pid === pid)?.sandboxed;
  if (s === undefined) return 'unknown';
  return s ? 'enforced' : 'absent';
}
