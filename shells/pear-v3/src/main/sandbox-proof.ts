/**
 * Whether the OS is really confining the renderer, read from outside it. The absence of
 * `--no-sandbox` is what the app asked for; this is what it got. Linux: a sandboxed renderer runs
 * under a seccomp-bpf filter (`Seccomp: 2` in `/proc/<pid>/status`). macOS and Windows: the
 * `sandboxed` field of Electron's process metrics. Pure, so the tests drive every answer.
 */
export type RendererSandbox = 'enforced' | 'absent' | 'unknown';

export function fromProcStatus(text: string): RendererSandbox {
  const m = /^Seccomp:\s*(\d+)\s*$/m.exec(text);
  if (m === null) return 'unknown';
  return m[1] === '2' ? 'enforced' : 'absent';
}

export function fromMetrics(
  metrics: readonly { readonly pid: number; readonly sandboxed?: boolean }[],
  pid: number,
): RendererSandbox {
  const s = metrics.find((m) => m.pid === pid)?.sandboxed;
  if (s === undefined) return 'unknown';
  return s ? 'enforced' : 'absent';
}
