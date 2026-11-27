/**
 * The AppImage's `AppRun`. It exists for one case: a machine where Chromium's sandbox cannot start.
 * Stock Ubuntu 24.04 and later restrict the user namespaces it needs; a container's seccomp profile
 * (Docker's default) refuses them, with no setting that says so; and an AppImage cannot hold a
 * setuid helper. There, Chromium aborts before any app code, so the user would never reach the
 * warning that ADR 0001's amendment, item 2 promises.
 *
 * It never decides from the distribution, and never adds the switch on a guess. It asks Chromium,
 * with a run that stops as soon as main starts (`SANDBOX_PREFLIGHT_SWITCH`), whenever the namespaces
 * may be out of reach: a kernel setting reports a limit, or making them the way the sandbox does
 * fails (`USERNS_PROBE`; with no `unshare` to try, it asks too). Only if Chromium then fails with its
 * own sandbox error does the app start with `--no-sandbox`, and main answers that with the warning,
 * Quit first, before any window or worker. Everywhere else the app starts with exactly the arguments
 * it was given.
 */
import { SANDBOX_PREFLIGHT_SWITCH } from '../src/shared/ids.ts';

/** Kernel settings that can stop an unprivileged process from using user namespaces. */
export const USERNS_LIMITS: readonly (readonly [file: string, limitedValue: string])[] = [
  ['/proc/sys/kernel/apparmor_restrict_unprivileged_userns', '1'],
  ['/proc/sys/kernel/unprivileged_userns_clone', '0'],
  ['/proc/sys/user/max_user_namespaces', '0'],
];

/**
 * What Chromium's namespace sandbox needs, tried for real: a user namespace this user is mapped
 * into, and in it the PID and network namespaces the zygote gets. A filter that refuses them has no
 * setting to read, so only trying finds it. It runs `/bin/sh`, which is there wherever AppRun is.
 */
export const USERNS_PROBE: readonly string[] = [
  'unshare',
  '--user',
  '--map-root-user',
  '--pid',
  '--net',
  '--fork',
  '/bin/sh',
  '-c',
  ':',
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
# No setting says so when a filter refuses the namespaces (a container's seccomp profile): try them.
[ -n "$limited" ] || ${USERNS_PROBE.join(' ')} </dev/null >/dev/null 2>&1 || limited=1

if [ -n "$limited" ]; then
  why=$("$app" --${SANDBOX_PREFLIGHT_SWITCH} 2>&1 >/dev/null) || case $why in
    *'${SANDBOX_FATAL}'*) exec "$app" --no-sandbox "$@" ;;
  esac
fi
exec "$app" "$@"
`;
}
