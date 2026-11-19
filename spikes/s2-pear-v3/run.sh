#!/usr/bin/env bash
# Spike S2 harness: Pear v3 install and the update gate, from Holepunch's Electron template.
#
# Runs ONLY in a throwaway VM or CI job, never on a developer machine: it installs system
# packages, bootstraps Pear, builds Electron apps and runs them as root with Chromium's sandbox
# OFF (the guest has NoNewPrivs=1 and seccomp). From a laptop:
#
#   kata-run --net --no-setup --max-wait 5400 --timeout 5000 --cwd <worktree> -- \
#     bash spikes/s2-pear-v3/run.sh
#
# S2_PHASES picks phases (space-separated, in order); the default is all of them. S2_WORK is
# the scratch root (default /var/tmp/s2). HOME is pointed inside it, so Pear, its sidecar
# storage and the installed app never touch the real HOME.
#
# Secrets: `pear touch` creates link write keys in the sidecar's storage under
# $HOME/.config/pear. They stay in the VM. This script prints links (public keys) only, and
# lists file NAMES only, with that directory pruned.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
. "$HERE/pins.env"

ALL="env deps bootstrap cli template link make1 build1 stage1 install launch-checks run1 \
update2 hold restart-held wrong-notice update3 stale-notice apply restart-applied provision \
multisig-demo sandbox-nonroot"
PHASES=${S2_PHASES:-$ALL}
W=${S2_WORK:-/var/tmp/s2}
export HOME=$W/home
export npm_config_cache=$W/npm-cache
export npm_config_update_notifier=false
PEAR=$HOME/.local/bin/pear
APPDIR=$W/dl-template/app
BUILDS=$W/builds
DIST=$W/dist
LOGS=$W/logs
CFG=$HOME/.config/HelloPear
EVENTS=$CFG/s2-events.jsonl
NOTICE=$CFG/s2-notice.json
HOSTARCH=linux-x64
PY=(python3 -I "$HERE/s2.py")
mkdir -p "$W" "$HOME" "$LOGS" "$BUILDS" "$DIST"
touch "$W/state.env"
. "$W/state.env"

hdr() { printf '\n======== [S2 %s] %s ========\n' "$(date -u +%H:%M:%S)" "$*"; }
run() {
  printf '$ %s\n' "$*"
  "$@"
  local rc=$?
  printf '[exit %s]\n' "$rc"
  return $rc
}
state() { echo "$1=$2" >> "$W/state.env"; eval "$1=\$2"; echo "STATE $1=$2"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
events_from() { "${PY[@]}" show "$EVENTS" "${1:-0}"; }
ev_count() { "${PY[@]}" count "$EVENTS" "$1"; }
ev_wait() { "${PY[@]}" wait "$EVENTS" "$1" "$2" "$3"; }
ev_waitfor() { "${PY[@]}" waitfor "$EVENTS" "$@"; } # FROM TIMEOUT EV [K=V ...]
lines() { if [ -f "$EVENTS" ]; then wc -l < "$EVENTS"; else echo 0; fi; }

# ---------------------------------------------------------------------------------------------
p_env() {
  hdr "env: ${S2_ENV:-unknown} (S2_ENV)"
  run node --check "$HERE/worker-instrumented.js" || return 1
  grep -E '^(ID|VERSION_ID|PRETTY_NAME)=' /etc/os-release
  uname -a
  id
  grep -E '^(NoNewPrivs|Seccomp|Seccomp_filters|CapEff):' /proc/self/status
  echo "nproc=$(nproc)"
  free -m
  df -hT / /tmp /var/tmp "$W" 2>&1
  echo "--- FUSE"
  ls -l /dev/fuse 2>&1
  command -v fusermount fusermount3 2>&1 || echo "no fusermount"
  ldconfig -p | grep -E 'libfuse|libatomic' || echo "no libfuse/libatomic in ldconfig"
  echo "--- user namespaces"
  for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces \
    /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
    echo "$f=$(cat "$f" 2>&1)"
  done
  run unshare -U -r true
  run setpriv --reuid=65534 --regid=65534 --clear-groups unshare -U -r true
  echo "--- tools"
  for t in xvfb-run Xvfb apt-get node npm npx git python3 curl; do
    printf '%s=%s\n' "$t" "$(command -v $t || echo missing)"
  done
  node -v; npm -v; git --version
  echo "--- network"
  getent hosts node1.hyperdht.org node2.hyperdht.org node3.hyperdht.org registry.npmjs.org
  python3 -I - <<'EOF'
import socket, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(5)
try:
    s.sendto(b'\x1b' + 47 * b'\0', ('pool.ntp.org', 123)); d, a = s.recvfrom(512)
    print('udp/123 to pool.ntp.org: reply', len(d), 'bytes from', a[0])
except Exception as e:
    print('udp/123 to pool.ntp.org: FAILED', e)
EOF
  for u in https://registry.npmjs.org/ https://github.com/; do
    echo "$u -> $(curl -sS -o /dev/null -w '%{http_code}' "$u" 2>&1)"
  done
}

p_deps() {
  hdr "deps: xvfb and Electron's libraries"
  export DEBIAN_FRONTEND=noninteractive
  run bash -c 'apt-get update -qq 2>&1 | tail -3'
  local want="xvfb xauth libgtk-3-0 libgtk-3-0t64 libnss3 libgbm1 libasound2 libasound2t64 \
libxss1 libxtst6 libatk-bridge2.0-0 libatk-bridge2.0-0t64 libdrm2 libxkbcommon0 libatomic1 \
libsecret-1-0 libnotify4 dbus-x11 file squashfs-tools procps"
  local have=""
  for p in $want; do
    apt-cache show "$p" >/dev/null 2>&1 && have="$have $p"
  done
  run bash -c "apt-get install -y -qq --no-install-recommends $have 2>&1 | tail -3"
  for t in xvfb-run Xvfb unsquashfs; do printf '%s=%s\n' "$t" "$(command -v $t || echo missing)"; done
}

p_bootstrap() {
  hdr "bootstrap: npx pear@$PEAR_NPM_VERSION (HOME=$HOME)"
  mkdir -p "$W/dl-pear-bootstrap"
  local got
  got=$(npm view "pear@$PEAR_NPM_VERSION" dist.integrity 2>&1)
  echo "registry dist.integrity: $got"
  if [ "$got" != "$PEAR_NPM_INTEGRITY" ]; then
    echo "INTEGRITY MISMATCH: pinned $PEAR_NPM_INTEGRITY"
    return 1
  fi
  echo "integrity matches the pin"
  # The bootstrapper gives HyperDHT 30 s to find the platform drive and exits 0 even when that
  # times out (seen 2026-11-19), so success is judged by the binary it leaves behind.
  local i
  for i in 1 2 3 4 5 6; do
    (cd "$W/dl-pear-bootstrap" && run timeout 1500 npx --yes "pear@$PEAR_NPM_VERSION" </dev/null)
    [ -x "$PEAR" ] && { echo "bootstrap: attempt $i installed $PEAR"; break; }
    echo "bootstrap: attempt $i left no $PEAR"
    sleep 20
  done
  echo "--- what npx installed (registry integrity of each)"
  "${PY[@]}" npxlock "$npm_config_cache"
  ls -la "$HOME/.local/bin" 2>&1
  file -L "$PEAR" 2>&1
  [ -x "$PEAR" ]
}

p_cli() {
  hdr "cli: platform version and help"
  run timeout 120 "$PEAR" -v </dev/null
  run timeout 120 "$PEAR" -v --json </dev/null
  run timeout 120 "$PEAR" versions -m </dev/null
  run timeout 120 "$PEAR" info </dev/null
  run timeout 60 "$PEAR" </dev/null
  run timeout 60 "$PEAR" help </dev/null
  local c s
  for c in touch seed build stage provision multisig info dump install data changelog sidecar gc \
    cores identity versions blind-peer blind-relay make; do
    run timeout 60 "$PEAR" "$c" -h </dev/null
  done
  for s in "keys" "keys get" "keys paths" "keys list" "keys add" "keys remove" link request sign \
    verify commit; do
    # shellcheck disable=SC2086
    run timeout 60 "$PEAR" multisig $s -h </dev/null
  done
}

p_template() {
  hdr "template: $TEMPLATE_REPO @ $TEMPLATE_COMMIT"
  mkdir -p "$W/dl-template"
  run git clone -q "$TEMPLATE_REPO" "$APPDIR" || return 1
  run git -C "$APPDIR" checkout -q "$TEMPLATE_COMMIT" || return 1
  git -C "$APPDIR" log -1 --format='%H %ci %s'
  (cd "$APPDIR" && run bash -o pipefail -c \
    'npm ci --ignore-scripts --no-audit --no-fund --loglevel=error 2>&1 | tail -5') || return 1
  (cd "$APPDIR" && run node node_modules/electron/install.js) || return 1
  (cd "$APPDIR" && npm ls pear-runtime pear-runtime-updater electron @electron-forge/cli \
    pear-electron-forge-maker-appimage bare-sidecar hyperswarm hyperdrive 2>&1 | head -40)
  cat "$APPDIR/pear.json"
}

p_link() {
  hdr "link: pear touch, a background seeder, package.json#upgrade, the instrumented worker"
  run bash -o pipefail -c "timeout 120 '$PEAR' touch --json </dev/null | tee '$LOGS/touch.ndjson'" || return 1
  state LINK "$("${PY[@]}" jlast "$LOGS/touch.ndjson" link)"
  [ -n "$LINK" ] || return 1
  nohup "$PEAR" seed --no-tty --json "$LINK" </dev/null > "$LOGS/seed.ndjson" 2>&1 &
  state SEED_PID $!
  (cd "$APPDIR" && npm pkg set "upgrade=$LINK" && npm pkg get name productName version upgrade main)
  cp "$HERE/worker-instrumented.js" "$APPDIR/workers/main.js"
  git -C "$APPDIR" diff --stat
}

make_app() { # $1 version, $2 full|appimage
  hdr "make $1 ($2)"
  (cd "$APPDIR" && npm version "$1" --no-git-tag-version --allow-same-version >/dev/null)
  rm -rf "$APPDIR/out"
  local ok=1
  if [ "$2" = full ]; then
    (cd "$APPDIR" && run bash -o pipefail -c 'timeout 1500 npm run make 2>&1 | tail -40') && ok=0
  fi
  if [ $ok -ne 0 ]; then
    (cd "$APPDIR" && run bash -o pipefail -c \
      'timeout 1500 npx electron-forge make --targets pear-electron-forge-maker-appimage 2>&1 | tail -30') || return 1
  fi
  echo "--- out/ (depth 2)"
  (cd "$APPDIR/out" && find . -maxdepth 2 -printf '%y %12s %p\n' | sort -k3)
  local aimg
  aimg=$(ls "$APPDIR"/out/make/*"$1"*.AppImage 2>/dev/null | head -1)
  [ -n "$aimg" ] || { echo "no AppImage for $1"; return 1; }
  echo "forge AppImage: $aimg sha256=$(sha "$aimg")"
  mkdir -p "$DIST/$1"
  cp "$aimg" "$DIST/$1/HelloPear.AppImage"
  state "FORGE_AIMG_${1//./_}" "$aimg"
  state "SHA_${1//./_}" "$(sha "$DIST/$1/HelloPear.AppImage")"
}

build_dir() { # $1 version
  local t="$BUILDS/hello-pear-electron-$1"
  if [ "$1" = 1.0.0 ]; then
    hdr "pear build with Forge's own file name (expected to be refused)"
    local f
    eval "f=\$FORGE_AIMG_${1//./_}"
    (cd "$W" && run timeout 120 "$PEAR" build --package "$APPDIR/package.json" \
      --linux-x64-app "$f" --target "$BUILDS/refused-$1" --json </dev/null)
  fi
  hdr "pear build $1"
  (cd "$W" && run timeout 300 "$PEAR" build --package "$APPDIR/package.json" \
    --linux-x64-app "$DIST/$1/HelloPear.AppImage" --target "$t" --json </dev/null) || return 1
  echo "--- deployment folder $t"
  (cd "$t" && find . -printf '%y %12s %m %p\n' | sort -k4 && sha256sum package.json by-arch/*/app/*)
  python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print({k: d.get(k) for k in ("name","productName","version","upgrade","main")})' "$t/package.json"
}

stage_dir() { # $1 version
  local t="$BUILDS/hello-pear-electron-$1"
  hdr "pear stage --dry-run $1"
  run bash -c "timeout 600 '$PEAR' stage --dry-run --json '$LINK' '$t' </dev/null > '$LOGS/stage-dry-$1.ndjson' 2>&1"
  head -c 4000 "$LOGS/stage-dry-$1.ndjson"; echo
  hdr "pear stage $1"
  run bash -c "timeout 900 '$PEAR' stage --json '$LINK' '$t' </dev/null > '$LOGS/stage-$1.ndjson' 2>&1" || { cat "$LOGS/stage-$1.ndjson"; return 1; }
  head -c 6000 "$LOGS/stage-$1.ndjson"; echo
  state "VERLINK_${1//./_}" "$("${PY[@]}" jlast "$LOGS/stage-$1.ndjson" verlink)"
  run timeout 120 "$PEAR" info "$LINK" </dev/null
  run timeout 120 "$PEAR" dump --list "$LINK" </dev/null
}

p_make1() { make_app 1.0.0 full; }
p_build1() { build_dir 1.0.0; }
p_stage1() { stage_dir 1.0.0; }

p_install() {
  hdr "pear install $LINK"
  touch "$W/install.mark"
  local i ok=1
  for i in 1 2 3; do
    run bash -o pipefail -c "timeout 600 '$PEAR' install '$LINK' --json --timeout 300 </dev/null | tee '$LOGS/install.ndjson'" && { ok=0; break; }
    echo "install: attempt $i failed"
    sleep 20
  done
  [ $ok -eq 0 ] || return 1
  state INSTALLED "$("${PY[@]}" jlast "$LOGS/install.ndjson" dest)"
  ls -la "$INSTALLED"
  echo "installed sha256=$(sha "$INSTALLED") build 1.0.0 sha256=$SHA_1_0_0"
  echo "--- HOME after install (names only; build caches and Pear's own storage pruned)"
  (cd "$HOME" && find . \( -path ./.config/pear -o -path ./.cache -o -path ./.npm \) -prune -o -printf '%y %12s %p\n' | sort -k3 | head -80)
  echo "--- every .desktop file written since the install started"
  find "$HOME" /root /usr/share/applications /usr/local/share/applications -name '*.desktop' \
    -newer "$W/install.mark" -not -path "$HOME/.config/pear/*" 2>/dev/null | head -20
  echo "--- top level of Pear's storage (names only)"
  ls -la "$HOME/.config/pear" 2>&1
  echo "--- the .desktop entry pear install wrote"
  cat "$HOME/.local/share/applications/HelloPear.desktop" 2>&1
  # A second install refuses to overwrite: that refusal is the expected result.
  run timeout 300 "$PEAR" install "$LINK" --timeout 120 </dev/null
  return 0
}

p_launch_checks() {
  hdr "launch checks: AppImage contents, FUSE, the root/sandbox refusal"
  rm -rf "$W/extract" && mkdir -p "$W/extract"
  (cd "$W/extract" && run bash -c "'$INSTALLED' --appimage-extract >/dev/null")
  echo "--- AppRun (the whole file when it is a script)"
  file "$W/extract/squashfs-root/AppRun"
  if [ "$(head -c 2 "$W/extract/squashfs-root/AppRun")" = '#!' ]; then
    cat -n "$W/extract/squashfs-root/AppRun"
  fi
  echo "--- the AppImage's own .desktop"
  cat "$W"/extract/squashfs-root/*.desktop
  echo "--- chrome-sandbox and top level"
  ls -la "$W/extract/squashfs-root/" | head -40
  ls -la "$W/extract/squashfs-root/chrome-sandbox" 2>&1
  echo "--- runtime type, and the FUSE library and helper its first 256 KiB name"
  head -c 16 "$INSTALLED" | od -A x -t x1z | head -2
  head -c 262144 "$INSTALLED" | grep -a -o -E 'libfuse[0-9]?\.so(\.[0-9]+)?|fusermount3?' | sort | uniq -c
  hdr "run the AppImage as is (needs FUSE)"
  run timeout 30 xvfb-run -a "$INSTALLED"
  hdr "--appimage-extract-and-run as root, sandbox not disabled"
  run timeout 40 xvfb-run -a "$INSTALLED" --appimage-extract-and-run
  sleep 2
  kill_leftover_workers
  rm -rf "$CFG"  # the refused runs may have created app storage; start clean
}

# A worker that outlives its window would hold the app's corestore lock: stop it (VM only).
worker_pids() { ps -eo pid,args | grep -E 'workers/main.js' | grep -v grep | awk '{print $1}'; }
kill_leftover_workers() {
  local p i
  for p in $(worker_pids); do
    echo "killing leftover worker $p"; kill -TERM "$p"
  done
  for i in $(seq 1 20); do [ -z "$(worker_pids)" ] && return 0; sleep 1; done
  for p in $(worker_pids); do echo "worker $p ignored TERM: KILL"; kill -KILL "$p"; done
  sleep 1
  return 0
}

APP_PID=""
start_app() { # $1 tag
  hdr "start app ($1): --appimage-extract-and-run --no-sandbox under xvfb (sandbox off)"
  (cd "$W" && ELECTRON_ENABLE_LOGGING=1 exec setsid xvfb-run -a -s '-screen 0 1280x800x24' \
    "$INSTALLED" --appimage-extract-and-run --no-sandbox) > "$LOGS/app-$1.log" 2>&1 &
  APP_PID=$!
  echo "app pid/pgid $APP_PID"
}
stop_app() { # $1 tag
  hdr "stop app ($1)"
  kill -TERM -- "-$APP_PID" 2>/dev/null
  local i
  for i in $(seq 1 30); do kill -0 "$APP_PID" 2>/dev/null || break; sleep 1; done
  kill -KILL -- "-$APP_PID" 2>/dev/null
  wait "$APP_PID" 2>/dev/null
  sleep 2
  echo "--- leftover app processes"
  ps -eo pid,pgid,args | grep -E 'HelloPear|workers/main.js|appimage_extracted' | grep -v grep | cut -c1-200
  kill_leftover_workers
  echo "--- app log (filtered)"
  grep -v -E 'dbus|Gtk-WARNING|libva|viz_main|gpu_init|ui/gl|Fontconfig|bus.cc|object_proxy' "$LOGS/app-$1.log" | tail -40
}
ps_app() {
  echo "--- app processes (args cut at 220 chars)"
  ps -eo pid,ppid,pgid,args | grep -E 'HelloPear|bare|Xvfb' | grep -v grep | cut -c1-220
}

p_run1() {
  start_app run1
  ev_waitfor 0 180 worker-start || { echo "worker did not start"; tail -60 "$LOGS/app-run1.log"; return 1; }
  ev_waitfor 0 300 read-ahead || echo "no startup read-ahead within 300 s"
  ps_app
  sleep 10
  hdr "events so far (run1)"
  events_from 0
}

update_to() { # $1 version
  make_app "$1" appimage || return 1
  build_dir "$1" || return 1
  local mark
  mark=$(lines)
  stage_dir "$1" || return 1
  local v
  eval "v=\$VERLINK_${1//./_}"
  hdr "waiting for the running app's updater to hold $v ($1)"
  ev_waitfor "$mark" 300 gate-candidate "verlink=$v" || echo "no gate-candidate for $v within 300 s"
  sleep 5
  events_from "$mark"
  echo "stage verlink:   $v"
  echo "build sha256:    $(eval echo \$SHA_${1//./_})"
  echo "installed now:   $(sha "$INSTALLED")"
}

p_update2() { update_to 1.0.1; }

p_hold() {
  hdr "hold: no notice for 60 s"
  local mark; mark=$(lines)
  sleep 60
  events_from "$mark"
  echo "installed sha256 $(sha "$INSTALLED") (1.0.0 = $SHA_1_0_0)"
  ls -la "$CFG/pear-runtime/next" 2>&1
  return 0
}

p_restart_held() {
  stop_app run1
  echo "after stop: installed sha256 $(sha "$INSTALLED") (1.0.0 = $SHA_1_0_0)"
  ls -la "$CFG/pear-runtime/next" 2>&1
  local mark; mark=$(lines)
  start_app run2
  ev_waitfor "$mark" 180 worker-start || { echo "worker did not start"; return 1; }
  ev_waitfor "$mark" 300 gate-candidate "verlink=$VERLINK_1_0_1" || echo "no gate-candidate within 300 s"
  sleep 5
  events_from "$mark"
  echo "after restart: installed sha256 $(sha "$INSTALLED") (1.0.0 = $SHA_1_0_0)"
}

write_notice() { # $1 verlink, $2 sha
  printf '{"verlink":"%s","sha256":{"%s":"%s"}}\n' "$1" "$HOSTARCH" "$2" > "$NOTICE"
  echo "notice: $(cat "$NOTICE")"
}

p_wrong_notice() {
  hdr "a notice naming 1.0.1 with the wrong sha256"
  local mark; mark=$(lines)
  write_notice "$VERLINK_1_0_1" "0000000000000000000000000000000000000000000000000000000000000000"
  sleep 15
  events_from "$mark"
  echo "installed sha256 $(sha "$INSTALLED") (1.0.0 = $SHA_1_0_0)"
}

p_update3() { update_to 1.0.2; }

p_stale_notice() {
  hdr "a correct notice for 1.0.1, after the updater moved on to 1.0.2"
  local mark; mark=$(lines)
  write_notice "$VERLINK_1_0_1" "$SHA_1_0_1"
  sleep 15
  events_from "$mark"
  echo "installed sha256 $(sha "$INSTALLED") (1.0.0 = $SHA_1_0_0)"
}

p_apply() {
  hdr "the notice for 1.0.2: the gate applies"
  local mark; mark=$(lines)
  write_notice "$VERLINK_1_0_2" "$SHA_1_0_2"
  ev_waitfor "$mark" 180 gate-applied || echo "no gate-applied within 180 s"
  sleep 3
  events_from "$mark"
  echo "installed sha256 $(sha "$INSTALLED") (1.0.2 = $SHA_1_0_2)"
  ls -la "$(dirname "$INSTALLED")" "$CFG/pear-runtime/next" 2>&1
  return 0
}

p_restart_applied() {
  stop_app run2
  local mark; mark=$(lines)
  start_app run3
  ev_waitfor "$mark" 180 worker-start || { echo "worker did not start"; return 1; }
  ev_waitfor "$mark" 240 read-ahead || true
  sleep 20
  events_from "$mark"
  stop_app run3
}

p_provision() {
  hdr "pear provision --dry-run (a throwaway target)"
  run bash -o pipefail -c "timeout 120 '$PEAR' touch --json </dev/null > '$LOGS/touch-prov.ndjson'"
  local t key
  t=$("${PY[@]}" jlast "$LOGS/touch-prov.ndjson" link)
  key=${t#pear://}
  run timeout 600 "$PEAR" provision --dry-run --json "$VERLINK_1_0_2" "$t" "pear://0.0.$key" </dev/null
  return 0
}

p_multisig_demo() {
  hdr "pear multisig link from a throwaway pear.json (three public keys of throwaway links)"
  mkdir -p "$W/msig"
  local i keys=()
  for i in 1 2 3; do
    timeout 120 "$PEAR" touch --json </dev/null > "$LOGS/touch-ms$i.ndjson"
    keys+=("$("${PY[@]}" jlast "$LOGS/touch-ms$i.ndjson" link | sed 's#^pear://##')")
  done
  printf '{"multisig":{"publicKeys":["%s","%s","%s"],"namespace":"sovtech/s2-demo","quorum":2}}\n' \
    "${keys[0]}" "${keys[1]}" "${keys[2]}" > "$W/msig/pear.json"
  cat "$W/msig/pear.json"
  (cd "$W/msig" && run timeout 120 "$PEAR" multisig link --json </dev/null)
  sed -i 's#sovtech/s2-demo#sovtech/s2-demo-2#' "$W/msig/pear.json"
  (cd "$W/msig" && run timeout 120 "$PEAR" multisig link --json </dev/null)
  (cd "$W/msig" && run timeout 120 "$PEAR" multisig request "$VERLINK_1_0_2" </dev/null)
  return 0
}

# Chromium's sandbox, shown positively: each Electron process with its type, its user, pid and
# net namespaces, its seccomp mode and NoNewPrivs, and whether --no-sandbox is on its command line.
# Sandboxed renderers sit in namespaces of their own with Seccomp 2.
sandbox_report() { # $1 tag
  local p t a
  echo "--- sandbox report ($1)"
  for p in $(ps -eo pid,args | grep -E 'HelloPear|workers/main.js' \
    | grep -v -E 'grep|xvfb-run|Xvfb|timeout |setpriv|setsid|bash -c' | awk '{print $1}'); do
    a=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
    t=$(printf '%s' "$a" | grep -o -E -- '--type=[a-z-]+' | head -1)
    case "$a" in *workers/main.js*) t=worker ;; esac
    printf '%-7s %-20s uid=%s user=%s pid=%s net=%s %s %s no-sandbox-flag=%s\n' "$p" "${t:-browser}" \
      "$(awk '/^Uid:/{print $2}' "/proc/$p/status" 2>/dev/null)" \
      "$(readlink "/proc/$p/ns/user" 2>/dev/null)" "$(readlink "/proc/$p/ns/pid" 2>/dev/null)" \
      "$(readlink "/proc/$p/ns/net" 2>/dev/null)" \
      "$(grep -E '^Seccomp:' "/proc/$p/status" 2>/dev/null | tr -d '\t ')" \
      "$(grep -E '^NoNewPrivs:' "/proc/$p/status" 2>/dev/null | tr -d '\t ')" \
      "$(printf '%s' "$a" | grep -c -- '--no-sandbox')"
  done
}

run_nonroot() { # $1 tag, then the AppImage's arguments. Runs it as s2user for up to 30 s.
  local tag=$1 p i rc=running
  shift
  hdr "non-root ($tag): ./HelloPear.AppImage $*"
  (cd /home/s2user && ELECTRON_ENABLE_LOGGING=1 exec setsid setpriv --reuid=s2user --regid=s2user \
    --init-groups env HOME=/home/s2user TMPDIR=/home/s2user/tmp XDG_CONFIG_HOME=/home/s2user/.config \
    xvfb-run -a -s '-screen 0 1280x800x24' ./HelloPear.AppImage "$@") \
    > "$LOGS/app-nonroot-$tag.log" 2>&1 &
  p=$!
  for i in $(seq 1 30); do
    kill -0 "$p" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$p" 2>/dev/null; then
    echo "still running after 30 s"
    sandbox_report "$tag"
    kill -TERM -- "-$p" 2>/dev/null
    sleep 3
    kill -KILL -- "-$p" 2>/dev/null
    wait "$p" 2>/dev/null
  else
    wait "$p"
    rc=$?
    echo "exited by itself after about $i s, status $rc"
  fi
  kill_leftover_workers
  echo "--- app log (filtered)"
  grep -v -E 'dbus|Gtk-WARNING|libva|Fontconfig|bus.cc|object_proxy|viz_main|gpu_init|ui/gl' \
    "$LOGS/app-nonroot-$tag.log" | tail -25
}

p_sandbox_nonroot() {
  hdr "Chromium's sandbox as a non-root user (no --no-sandbox), env=${S2_ENV:-unknown}"
  for f in /proc/sys/kernel/unprivileged_userns_clone /proc/sys/user/max_user_namespaces \
    /proc/sys/kernel/apparmor_restrict_unprivileged_userns; do
    echo "$f=$(cat "$f" 2>&1)"
  done
  ls -l /dev/fuse 2>&1
  command -v fusermount fusermount3 2>&1 || echo "no fusermount"
  ldconfig -p | grep -E 'libfuse' || echo "no libfuse in ldconfig"
  grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status
  id s2user >/dev/null 2>&1 || useradd -m s2user
  cp "$INSTALLED" /home/s2user/HelloPear.AppImage && chown s2user: /home/s2user/HelloPear.AppImage
  install -d -o s2user -g s2user /home/s2user/tmp
  run setpriv --reuid=s2user --regid=s2user --init-groups unshare -U -r true
  run_nonroot fuse
  run_nonroot extract --appimage-extract-and-run
  if [ -e /dev/fuse ] && ! ldconfig -p | grep -q 'libfuse.so.2'; then
    hdr "install libfuse2 (as a desktop user would for an AppImage), then FUSE again"
    export DEBIAN_FRONTEND=noninteractive
    local pkg=libfuse2t64
    apt-cache show "$pkg" >/dev/null 2>&1 || pkg=libfuse2
    run bash -c "apt-get install -y -qq --no-install-recommends $pkg 2>&1 | tail -3"
    run_nonroot fuse-libfuse2
  fi
  local aa=/proc/sys/kernel/apparmor_restrict_unprivileged_userns
  if [ -w "$aa" ] && [ "$(cat "$aa")" = 1 ]; then
    hdr "AppArmor's user-namespace restriction off (Debian's default), then both again"
    run sysctl -w kernel.apparmor_restrict_unprivileged_userns=0
    run setpriv --reuid=s2user --regid=s2user --init-groups unshare -U -r true
    [ -e /dev/fuse ] && run_nonroot fuse-userns-allowed
    run_nonroot extract-userns-allowed --appimage-extract-and-run
    run sysctl -w kernel.apparmor_restrict_unprivileged_userns=1
  fi
  return 0
}

p_cleanup() {
  hdr "cleanup"
  [ -n "$APP_PID" ] && kill -TERM -- "-$APP_PID" 2>/dev/null
  [ -n "${SEED_PID:-}" ] && { echo "--- seeder log (tail)"; tail -c 1500 "$LOGS/seed.ndjson"; kill -TERM "$SEED_PID" 2>/dev/null; }
  [ -x "$PEAR" ] && timeout 60 "$PEAR" sidecar shutdown </dev/null
  echo "--- state"; cat "$W/state.env"
}

rc=0
for ph in $PHASES; do
  fn="p_${ph//-/_}"
  if ! "$fn"; then
    echo "PHASE FAILED: $ph"
    rc=1
    break
  fi
  echo "PHASE OK: $ph"
done
p_cleanup
exit $rc
