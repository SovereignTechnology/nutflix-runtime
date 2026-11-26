#!/usr/bin/env bash
# The real-host proof, one side of it, in a throwaway Linux x64 VM with network access, as root
# (never on a developer machine and never on a CI runner: it joins the public HyperDHT).
#
#   bash shells/pear-v3/scripts/realhost/guest.sh seed --nonce <hex> [--wait-min 60]
#   bash shells/pear-v3/scripts/realhost/guest.sh play --nonce <hex> [--wait-min 30]
#   bash shells/pear-v3/scripts/realhost/guest.sh check      (the setup and the build alone)
#
# From the repository's root. It installs Electron's libraries, Xvfb and the AppImage tools, the
# submodule if the checkout lacks it, the npm lockfile's packages, builds, and runs `seed-side.ts`
# or `play-side.ts`. The playing side runs as an unprivileged user, so that Chromium's sandbox is on.
set -euo pipefail
side=${1:?seed or play}
shift
REPO=$(cd "$(dirname "$0")/../../../.." && pwd)
cd "$REPO"
export DEBIAN_FRONTEND=noninteractive
beat() { while sleep 30; do echo "[guest] $(date -u +%H:%M:%S) still working"; done; }
beat &
BEAT=$!
trap 'kill $BEAT 2>/dev/null || true' EXIT

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
if ! npm run build >/tmp/realhost-build.log 2>&1; then tail -60 /tmp/realhost-build.log; exit 1; fi
echo "[guest] built"

case "$side" in
  check)
    files="shells/pear-v3/scripts/realhost shells/pear-v3/src/update/root.ts shells/pear-v3/src/__tests__/update-gate.test.ts shells/pear-v3/packaging/update-root.ts"
    # shellcheck disable=SC2086
    npx --no-install prettier --check $files || true
    # shellcheck disable=SC2086
    npx --no-install eslint $files || true
    npx --no-install vitest run shells/pear-v3/src/__tests__/update-gate.test.ts 2>&1 | tail -25
    ;;
  seed)
    mkdir -p shells/pear-v3/out/appimage-runtime
    curl --proto '=https' --tlsv1.2 -fsSL -o shells/pear-v3/out/appimage-runtime/runtime-x86_64 \
      "https://github.com/SovereignTechnology/nutflix-runtime/releases/download/appimage-runtime-20251108-nutflix.1/runtime-x86_64"
    work=$(mktemp -d /tmp/realhost-seed.XXXXXX)
    node shells/pear-v3/scripts/realhost/seed-side.ts --work "$work" "$@"
    ;;
  play)
    # Chromium's user-namespace sandbox, for an unprivileged user in this throwaway VM.
    sysctl -w kernel.unprivileged_userns_clone=1 >/dev/null 2>&1 || true
    sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 >/dev/null 2>&1 || true
    echo "[guest] userns: max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo ?)"
    id rh >/dev/null 2>&1 || useradd -m -s /bin/bash rh
    chmod -R o+rX "$REPO" 2>/dev/null || true
    d=$REPO
    while [ "$d" != / ]; do chmod o+x "$d" 2>/dev/null || true; d=$(dirname "$d"); done
    runuser -u rh -- env HOME=/home/rh PATH="$PATH" xvfb-run -a -s '-screen 0 1280x800x24' \
      node shells/pear-v3/scripts/realhost/play-side.ts --work /home/rh/realhost "$@"
    ;;
  *)
    echo "seed or play" >&2
    exit 2
    ;;
esac
