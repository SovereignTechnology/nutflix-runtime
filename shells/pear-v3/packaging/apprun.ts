/**
 * The AppImage's `AppRun`. It exists for one case: a machine where Chromium's sandbox cannot start
 * (stock Ubuntu 24.04 and later restrict the user namespaces it needs, and an AppImage cannot hold
 * a setuid helper). There, Chromium aborts before any app code, so the user would never reach the
 * warning that ADR 0001's amendment, item 2 promises.
 *
 * It never decides from the distribution. Only when the kernel reports a limit does it ask
 * Chromium, with a run that stops as soon as main starts (`SANDBOX_PREFLIGHT_SWITCH`). Only if
 * Chromium then fails with its own sandbox error does the app start with `--no-sandbox`, and main
 * answers that with the warning, Quit first, before any window or worker. Everywhere else the app
 * starts with exactly the arguments it was given.
 */
import { SANDBOX_PREFLIGHT_SWITCH } from '../src/shared/ids.ts';

/** Kernel settings that can stop an unprivileged process from using user namespaces. */
export const USERNS_LIMITS: readonly (readonly [file: string, limitedValue: string])[] = [
  ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1'],
  ['/proc/sys/kernel/unprivileged_userns_clone', '0'],
  ['/proc/sys/user/max_user_namespaces', '0'],
];

/** Chromium's own message when it has no way to start the sandbox. */
export const SANDBOX_FATAL = 'SUID sandbox helper';

export function appRunScript(
  executableName: string,
  limits: readonly (readonly [string, string])[] = USERNS_LIMITS,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(executableName))
    throw new Error('AppRun: not a plain executable name');
  for (const [file, value] of limits)
    if (!/^[A-Za-z0-9/._-]+$/.test(file) || !/^[0-9]+$/.test(value))
      throw new Error('AppRun: not a plain limit');
  const checks = limits
    .map(([file, value]) => `[ "$(cat '${file}' 2>/dev/null)" = ${value} ] && limited=1`)
    .join('\n');
  return `#!/bin/sh
# Starts Nutflix. --no-sandbox is added only when Chromium itself reports that its sandbox cannot
# start, and the app then asks the user before it opens anything (packaging/apprun.ts).
here=$(dirname -- "$(readlink -f -- "$0")")
app="$here/usr/lib/${executableName}/${executableName}"

limited=
${checks}

if [ -n "$limited" ]; then
  why=$("$app" --${SANDBOX_PREFLIGHT_SWITCH} 2>&1 >/dev/null) || case $why in
    *'${SANDBOX_FATAL}'*) exec "$app" --no-sandbox "$@" ;;
  esac
fi
exec "$app" "$@"
`;
}
