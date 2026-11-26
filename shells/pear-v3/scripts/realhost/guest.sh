#!/usr/bin/env bash
# The real-host proof, one side of it, in a throwaway Linux x64 VM with network access, as root
# (never on a developer machine and never on a CI runner: it joins the public HyperDHT).
#
#   bash shells/pear-v3/scripts/realhost/guest.sh seed --nonce <hex> [--wait-min 60] [--no-t4]
#   bash shells/pear-v3/scripts/realhost/guest.sh play --nonce <hex> [--wait-min 30] [--no-t4]
#   bash shells/pear-v3/scripts/realhost/guest.sh check      (the setup, the build, lint, the root test)
#
# From the repository's root. It installs Electron's libraries, Xvfb and the AppImage tools, the
# submodule if the checkout lacks it, the npm lockfiles' packages (the root's, and for test 4 Pear
# v2's app and the S1 harness), builds, and runs `seed-side.ts` or `play-side.ts`. The playing side
# runs as an unprivileged user, as a viewer does. Exits non-zero when that side's tests failed.
set -euo pipefail
side=${1:?seed, play, both or check}
shift
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$REPO"
export DEBIAN_FRONTEND=noninteractive
# This run's own logs: a fresh directory, not a fixed path that another run or a planted file holds.
LOGS=$(mktemp -d /tmp/realhost-logs.XXXXXX)
beat() { while sleep 30; do echo "[guest] $(date -u +%H:%M:%S) still working"; done; }
beat &
BEAT=$!
trap 'kill $BEAT 2>/dev/null || true; rm -rf "$LOGS"' EXIT

echo "[guest] $(uname -srm); $(. /etc/os-release && echo "$PRETTY_NAME"); node $(node --version); $(nproc) cpus"
apt-get update -qq >/dev/null
pkgs="ffmpeg xvfb xauth squashfs-tools fuse3 unzip ca-certificates libatomic1 libnss3 libgbm1 libxss1 libxtst6 libnotify4 libdrm2 libxkbcommon0 libatk-bridge2.0-0 libxshmfence1 libcups2"
for p in libgtk-3-0t64:libgtk-3-0 libasound2t64:libasound2; do
  if apt-cache show "${p%%:*}" >/dev/null 2>&1; then pkgs="$pkgs ${p%%:*}"; else pkgs="$pkgs ${p##*:}"; fi
done
# shellcheck disable=SC2086
apt-get install -y -qq --no-install-recommends $pkgs >/dev/null
echo "[guest] packages installed; /dev/fuse $([ -e /dev/fuse ] && echo present || echo absent)"

pin=$(git ls-tree HEAD vendor/nutflix-pear 2>/dev/null | awk '{print $3}')
[ -n "$pin" ] || pin=$(git -C "$REPO" ls-files -s vendor/nutflix-pear 2>/dev/null | awk '{print $2}')
[[ "$pin" =~ ^[0-9a-f]{40}$ ]] || { echo "[guest] no submodule pin in this checkout: pass NUTFLIX_PEAR_PIN"; pin=${NUTFLIX_PEAR_PIN:?}; }
if [ ! -e vendor/nutflix-pear/package.json ]; then
  rm -rf vendor/nutflix-pear
  git clone -q https://github.com/SovereignTechnology/nutflix-pear.git vendor/nutflix-pear
  git -C vendor/nutflix-pear checkout -q "$pin"
fi
[ "$(git -C vendor/nutflix-pear rev-parse HEAD)" = "$pin" ] || { echo "submodule is not at $pin"; exit 1; }
echo "[guest] nutflix-pear at $pin ($(git -C vendor/nutflix-pear describe --tags 2>/dev/null || echo untagged))"

npm ci --ignore-scripts --no-audit --no-fund --loglevel=error
t4=yes
for a in "$@"; do
  if [ "$a" = --no-t4 ]; then t4=; fi
done
if [ -n "$t4" ] && [ "$side" != check ]; then
  # Test 4: Pear v2's app modules (staged by the seeding side) and the S1 harness's platform tools.
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --prefix shells/pear-v2/app
  npm ci --ignore-scripts --no-audit --no-fund --loglevel=error --prefix spikes/s1-pear-v2
fi
echo "[guest] memory: $(free -m | awk '/^Mem:/ {print $2" MiB total, "$7" MiB available"}'); swap $(free -m | awk '/^Swap:/ {print $2}') MiB"
# `npm run build` is `tsc -b`; --verbose names each project as it goes (the log keeps moving).
set +e
npx --no-install tsc -b --verbose 2>&1 | tee "$LOGS/build.log" | grep --line-buffered -E "Building project|error TS"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" != 0 ]; then
  echo "[guest] tsc -b: exit $rc"
  grep -A3 "error TS" "$LOGS/build.log" | head -80
  # The harness runs on Node's type stripping: its own type errors are reported, not fatal, outside
  # `check`. Any other error is.
  if [ "$side" = check ] || grep "error TS" "$LOGS/build.log" | grep -qvE "scripts/realhost/|proof/realhost.ts"; then exit 1; fi
fi
echo "[guest] built; memory available $(free -m | awk '/^Mem:/ {print $7}') MiB"

# The AppImage runtime the package step pins (`packaging/maker-appimage.ts`), from its release.
appimage_runtime() {
  local url
  url=$(grep -A1 'export const APPIMAGE_RUNTIME_DOWNLOAD' shells/pear-v3/packaging/maker-appimage.ts | grep -o "https://[^']*" | head -1)
  [[ "$url" =~ ^https://github\.com/SovereignTechnology/nutflix-runtime/releases/download/appimage-runtime-[0-9a-z.-]+$ ]] || { echo "[guest] no runtime pin"; exit 1; }
  mkdir -p shells/pear-v3/out/appimage-runtime
  curl --proto '=https' --tlsv1.2 -fsSL -o shells/pear-v3/out/appimage-runtime/runtime-x86_64 "$url/runtime-x86_64"
  echo "[guest] AppImage runtime ${url##*/} (the package step checks its sha256)"
}

# The playing side's user, and whether it may make the user namespaces Chromium's sandbox needs.
play_user() {
  sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 || true
  sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
  echo "[guest] userns: max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo ?); Seccomp $(awk '/^Seccomp:/ {print $2}' /proc/self/status)"
  id rh >/dev/null 2>&1 || useradd -m -s /bin/bash rh
  sbx=
  if ! runuser -u rh -- unshare --user --map-root-user --pid --net --fork /bin/sh -c : 2>/dev/null; then
    echo "[guest] an unprivileged user cannot make the user namespaces here: Chromium's sandbox cannot start"
    sbx=--sandbox-off
  fi
  chmod -R o+rX "$REPO" 2>/dev/null || true
  local d=$REPO
  while [ "$d" != / ]; do chmod o+x "$d" 2>/dev/null || true; d=$(dirname "$d"); done
}

case "$side" in
  check)
    files="shells/pear-v3/scripts/realhost shells/pear-v2/proof/realhost.ts shells/pear-v3/src/update/root.ts shells/pear-v3/src/__tests__/update-gate.test.ts shells/pear-v3/packaging/update-root.ts"
    # Every check runs and counts; the formatter's output is handed back only after they have.
    set +e
    # shellcheck disable=SC2086
    npx --no-install prettier --check $files 2>&1 | tail -12
    fmt=${PIPESTATUS[0]}
    # shellcheck disable=SC2086
    npx --no-install eslint $files
    lint=$?
    npx --no-install vitest run shells/pear-v3/src/__tests__/update-gate.test.ts 2>&1 | tail -25
    unit=${PIPESTATUS[0]}
    set -e
    if [ "$fmt" != 0 ]; then
      # The formatted files, for the branch (this repository's own code, nothing else).
      # shellcheck disable=SC2086
      npx --no-install prettier --write $files >/dev/null 2>&1 || true
      # shellcheck disable=SC2086
      echo "[guest] formatted begins $(tar -cz $files | base64 -w0)"
      echo "[guest] formatted ends"
    fi
    echo "[guest] check: prettier $fmt, eslint $lint, vitest $unit"
    [ "$fmt" = 0 ] && [ "$lint" = 0 ] && [ "$unit" = 0 ]
    ;;
  seed)
    appimage_runtime
    work=$(mktemp -d /tmp/realhost-seed.XXXXXX)
    node shells/pear-v3/scripts/realhost/seed-side.ts --work "$work" "$@"
    ;;
  both)
    # A dry run on ONE machine (no NAT between the two sides): the mechanics, not the proof.
    appimage_runtime
    work=$(mktemp -d /tmp/realhost-seed.XXXXXX)
    node shells/pear-v3/scripts/realhost/seed-side.ts --work "$work" "$@" > "$LOGS/seed.log" 2>&1 &
    seedpid=$!
    play_user
    set +e
    # shellcheck disable=SC2086
    runuser -u rh -- env HOME=/home/rh TMPDIR=/tmp PATH="$PATH" xvfb-run -a -s '-screen 0 1280x800x24' \
      node shells/pear-v3/scripts/realhost/play-side.ts --work "$(runuser -u rh -- mktemp -d /tmp/realhost-play.XXXXXX)" --local $sbx "$@"
    played=$?
    wait "$seedpid"
    seeded=$?
    set -e
    sed 's/^/[seed] /' "$LOGS/seed.log" | grep -v 'waiting:' | tail -60
    echo "[guest] play side exit $played, seed side exit $seeded"
    [ "$played" = 0 ] && [ "$seeded" = 0 ]
    ;;
  play)
    play_user
    # shellcheck disable=SC2086
    runuser -u rh -- env HOME=/home/rh TMPDIR=/tmp PATH="$PATH" xvfb-run -a -s '-screen 0 1280x800x24' \
      node shells/pear-v3/scripts/realhost/play-side.ts --work "$(runuser -u rh -- mktemp -d /tmp/realhost-play.XXXXXX)" $sbx "$@"
    ;;
  *)
    echo "seed, play, both or check" >&2
    exit 2
    ;;
esac
