#!/usr/bin/env bash
# The packaged AppImage in a container whose seccomp profile refuses user namespaces (Docker's
# default), on a kernel that reports no limit: no setting says that Chromium's sandbox cannot start
# there. Each launch is a fresh container, as this runner's user, with no network at all, so nothing
# can leave it (`smoke.ts` says what each one must show):
#
#   seccomp-warning     Docker's default profile, no stored choice: the warning, and no window.
#   seccomp-consented   the same, "Run anyway" stored: it runs, and its renderer must read as NOT
#                       confined, though Docker's filter is on every process in the container.
#   seccomp-sandboxed   a profile that filters one call and allows the namespaces: the sandbox
#                       starts, and the renderer must read as confined, though main is filtered too.
#                       Docker's AppArmor profile is left off there: this case is about reading a
#                       filtered renderer, not about which of Docker's layers Chromium can live with.
#
# All three run, whatever the first ones show; the script fails if any did.
#
# The kernel's own restriction must be lifted first, or AppRun would ask Chromium because of it and
# the run would prove nothing about the filter. Usage: seccomp-container.sh <Nutflix.AppImage>
set -euo pipefail

file=$(readlink -f "${1:?usage: seccomp-container.sh <Nutflix.AppImage>}")
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
node_dir=$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")
# Ubuntu 24.04, as on the runner. The digest is the multi-arch index's: the same pin on both arches.
base=ubuntu:24.04@sha256:562111b88caa79c71391c0c4d3c2114a7d5c35915c20561fd893cb1e07929e6b
image=nutflix-ci-seccomp

limit=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo absent)
case "$limit" in 0 | absent) ;; *)
  echo "this kernel still restricts user namespaces ($limit): lift that first" >&2
  exit 1
  ;;
esac

# Electron's system libraries and Xvfb, as the runner's own step installs them.
docker build -q -t "$image" - <<EOF
FROM $base
RUN apt-get update -qq \\
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends xvfb xauth \\
    libgtk-3-0t64 libnss3 libgbm1 libasound2t64 libxss1 libxtst6 libnotify4 \\
  && rm -rf /var/lib/apt/lists/*
EOF

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
# Allows everything but one call: a filter on every process, and user namespaces left alone.
printf '%s\n' '{"defaultAction":"SCMP_ACT_ALLOW","syscalls":[{"names":["kexec_load"],"action":"SCMP_ACT_ERRNO"}]}' \
  >"$work/allow-userns.json"

# smoke.ts <mode> in a fresh container. Any options before the mode go to `docker run`.
in_container() {
  local mode=${*: -1}
  local opts=("${@:1:$#-1}")
  echo "== $mode${opts[*]:+ (${opts[*]})}"
  docker run --rm --network none --user "$(id -u):$(id -g)" --shm-size 1g \
    -v "$repo:$repo:ro" -v "$node_dir:$node_dir:ro" -v "$file:/nutflix/Nutflix.AppImage:ro" \
    -e HOME=/tmp -e PATH="$node_dir/bin:/usr/bin:/bin" -w "$repo" \
    "${opts[@]}" "$image" \
    xvfb-run -a node shells/pear-v3/scripts/smoke.ts "$mode" \
    --file /nutflix/Nutflix.AppImage --timeout 180
}

failed=0
in_container seccomp-warning || failed=1
in_container seccomp-consented || failed=1
in_container --security-opt "seccomp=$work/allow-userns.json" --security-opt apparmor=unconfined \
  seccomp-sandboxed || failed=1
exit "$failed"
