#!/usr/bin/env bash
# Spike S1 harness. Runs ONLY in a throwaway VM (kata-run --net, or the workflow_dispatch job),
# never on a developer machine: it downloads and executes Pear and Electron binaries.
#
#   bash run.sh drive     env probe + find the last pre-v3 platform length (find-v2-length.js)
#   bash run.sh terminal  pinned install, the Bare terminal app (dir and pear:// link), a normal
#                         sidecar on Holepunch's key
#   bash run.sh stock     npx pear@2.0.1 and @2.0.4 as a user would run them today
#   bash run.sh trials    Q2: re-home the pin onto a release line in this VM, then update trials
#   bash run.sh gui       pinned install, the pear-electron GUI app and the renderer probe
#   bash run.sh hold      terminal + stock + trials in one go (over an hour: too long for agentrun)
#
# Each phase starts from a fresh VM and installs what it needs. PIN_LENGTH/PIN_FORK skip the
# auto-pin. S1_GUI_LINK=0 skips the pear:// GUI run (stage + run a link), for CI runners.
#
# Every result line starts with "S1 " (JSON) or "S1: " (text) so the job log can be grepped.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${S1_WORK:-/tmp/s1}"
mkdir -p "$WORK"
cd "$HERE" || exit 2

say() { printf 'S1: %s\n' "$*"; }
SUDO=""; [ "$(id -u)" = 0 ] || SUDO="sudo -n"   # GitHub runners: non-root with sudo

# runlog <label> <seconds> <dir> cmd...: run cmd in dir with stdin closed, keep the full output in
# $WORK/<label>.out, print its first 40 lines, and report the exit code.
runlog() {
  local label=$1 secs=$2 dir=$3; shift 3
  ( cd "$dir" && timeout "$secs" "$@" </dev/null >"$WORK/$label.out" 2>&1 )
  local rc=$?
  head -40 "$WORK/$label.out" | sed 's/^/S1:   /'
  say "$label exit: $rc"
  return $rc
}

probe_env() {
  say "== env"
  . /etc/os-release 2>/dev/null && say "os: ${PRETTY_NAME:-?}"
  say "kernel: $(uname -r) arch: $(uname -m)"
  say "id: $(id)"
  say "nproc: $(nproc) mem: $(awk '/MemTotal/ {print $2" kB"}' /proc/meminfo)"
  say "status: $(grep -E '^(NoNewPrivs|Seccomp):' /proc/self/status | tr '\n\t' '  ')"
  say "node: $(node --version 2>&1) npm: $(npm --version 2>&1)"
  say "disk: $(df -h "$WORK" | awk 'NR==2 {print $4" free"}')"
  say "apt-get: $(command -v apt-get || echo none)"
  if unshare -U true 2>/dev/null; then say "userns: unshare -U works"; else say "userns: unshare -U fails"; fi
  say "sysctl: unprivileged_userns_clone=$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo n/a) apparmor_restrict_unprivileged_userns=$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo n/a) max_user_namespaces=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo n/a)"
  say "runner: ${S1_ENV:-unlabelled}"
}

phase_drive() {
  probe_env
  say "== drive: find the last pre-v3 length"
  local store="$WORK/drive-store"
  rm -rf "$store" && mkdir -p "$store"
  ( cd "$HERE" && timeout 1800 node find-v2-length.js "$store" )
  say "drive exit: $?"
}

# The pin found by `run.sh drive` (see docs/spikes/S1-pear-v2-pin.md). Override with env.
PIN_LENGTH="${PIN_LENGTH:-}"
PIN_FORK="${PIN_FORK:-0}"
PD="$WORK/pear"                       # the pinned platform dir (PEAR_DIR)
PEAR="$PD/bin/pear"
RUNTIME_REL="current/by-arch/linux-x64/bin/pear-runtime"

need_pin() {
  [ -n "$PIN_LENGTH" ] && return 0
  # No pin given: find it now (same code as `run.sh drive`).
  say "== auto-pin: running find-v2-length.js"
  ensure_libs
  local store="$WORK/drive-store-autopin"
  rm -rf "$store" && mkdir -p "$store"
  timeout 1800 node find-v2-length.js "$store" >"$WORK/autopin.out" 2>&1
  grep -v '"tag":"probe"' "$WORK/autopin.out" | cut -c1-4000
  PIN_LENGTH=$(grep -o '"candidateLength":[0-9]*' "$WORK/autopin.out" | head -1 | cut -d: -f2)
  [ -n "$PIN_LENGTH" ] || PIN_LENGTH=$(grep -o '"latestLength":[0-9]*' "$WORK/autopin.out" | head -1 | cut -d: -f2)
  PIN_FORK=$(grep -o '"tag":"latest","t":[0-9]*,"length":[0-9]*,"fork":[0-9]*' "$WORK/autopin.out" | head -1 | grep -o '[0-9]*$')
  PIN_FORK=${PIN_FORK:-0}
  say "auto-pin: length=${PIN_LENGTH:-none} fork=$PIN_FORK"
  [ -n "$PIN_LENGTH" ] || { say "no pin found"; exit 3; }
}

ensure_libs() {
  # rocksdb-native (corestore 7, and the Pear runtime) needs libatomic.
  if ! ldconfig -p 2>/dev/null | grep -q libatomic.so.1; then
    say "installing libatomic1"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null && $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq libatomic1 >/dev/null
  fi
}

install_pinned() {
  need_pin
  ensure_libs
  rm -rf "$PD" && mkdir -p "$PD"
  say "== install: pinned bootstrap length=$PIN_LENGTH fork=$PIN_FORK"
  ( cd "$HERE" && timeout 2400 node pin-bootstrap.js "$PD" "$PIN_LENGTH" "$PIN_FORK" )
  local rc=$?
  say "pin-bootstrap exit: $rc"
  [ $rc -eq 0 ] || return $rc
  mkdir -p "$PD/bin" && ln -sfn "$PD/$RUNTIME_REL" "$PEAR"
  say "current -> $(readlink "$PD/current")"
  say "runtime sha256: $(sha256sum "$PD/$RUNTIME_REL" | cut -d' ' -f1)"
  return 0
}

stop_all_pear() {
  # Throwaway VM only: stop every sidecar and app so none can apply an update by path into a
  # directory we are about to restore.
  [ -x "$PEAR" ] && timeout 60 "$PEAR" sidecar shutdown </dev/null >/dev/null 2>&1
  sleep 3
  pkill -9 -f 'bin/pear-runtime' 2>/dev/null
  pkill -9 -f 'pear-runtime-app' 2>/dev/null
  sleep 2
}

current_state() {
  say "state[$1]: current -> $(readlink "$PD/current" 2>/dev/null || echo none); swaps: $(ls "$(dirname "$(readlink -f "$PD/current")")" 2>/dev/null | tr '\n' ' ')"
}

pear_versions() {
  runlog "versions-$(echo "$1" | tr -c 'a-z0-9\n' '-')" 120 "$HERE" "$PEAR" versions
  crash_logs "$1"
}

crash_logs() {
  # pear-crasher writes <name>.crash.log next to the running swap; show any, newest lines only.
  local f
  for f in $(find -L "$PD" -maxdepth 4 -name '*.crash.log' 2>/dev/null); do
    say "crash log [$1] ${f#$WORK/}:"
    tail -12 "$f" | cut -c1-300 | sed 's/^/S1:   /'
  done
}

phase_stock() {
  # The official v2 path, exactly as a user would take it today: npm pear@<v> with whatever its
  # semver ranges resolve to now, into an isolated HOME. 2.0.1 leaves hypercore unpinned; 2.0.3+
  # pin hypercore 11.29.0 (hypercore-storage ^2.8.0).
  local v
  for v in 2.0.1 2.0.4; do
    say "== stock: npx pear@$v with today's dependency tree"
    ensure_libs
    rm -rf "$WORK/stock-$v" "$WORK/stockhome-$v" && mkdir -p "$WORK/stock-$v" "$WORK/stockhome-$v"
    ( cd "$WORK/stock-$v" && npm install --no-audit --no-fund --no-save "pear@$v" >/dev/null 2>&1 ); say "stock $v npm install exit: $?"
    say "stock $v tree: $( cd "$WORK/stock-$v" && npm ls --all 2>/dev/null | grep -oE '(hypercore-storage|hypercore|rocksdb-native|corestore)@[0-9.]+' | sort -u | tr '\n' ' ')"
    runlog "stock-$v-bootstrap" 1200 "$WORK/stock-$v" env HOME="$WORK/stockhome-$v" node "$WORK/stock-$v/node_modules/pear/pear.js"
    local save_pd=$PD save_pear=$PEAR
    PD="$WORK/stockhome-$v/.config/pear"; PEAR="$PD/bin/pear"
    say "stock $v current -> $(readlink "$PD/current" | sed "s#$WORK/##")"
    HOME="$WORK/stockhome-$v" pear_versions "stock $v"
    kill_all_pear
    PD=$save_pd; PEAR=$save_pear
  done
}

run_terminal_app() {
  local app="$HERE/apps/terminal"
  say "== Q3a: terminal app from a local dir"
  runlog q3a-dir 180 "$app" "$PEAR" run "$app"
  say "== Q3a: terminal app from a pear:// link made with pear touch + pear stage"
  runlog q3a-touch 120 "$app" "$PEAR" touch --json
  local link
  link=$(grep -o 'pear://[a-z0-9]*' "$WORK/q3a-touch.out" | head -1)
  say "touch link: ${link:-none}"
  [ -n "$link" ] || return 1
  echo "$link" > "$WORK/terminal.link"
  runlog q3a-stage 600 "$app" "$PEAR" stage "$link" "$app"
  say "run pear:// without --trusted (no TTY, stdin closed):"
  runlog q3a-link-untrusted 120 "$app" "$PEAR" run "$link"
  say "run pear:// with --trusted:"
  runlog q3a-link 180 "$app" "$PEAR" run --trusted "$link"
}

watch_sidecar() {
  # $1 label, $2 seconds, rest: extra sidecar args. Runs `pear sidecar` (foreground, keep-alive,
  # logs at info) in the background and greps its log for platform update lines.
  local label=$1 secs=$2; shift 2
  local log="$WORK/sidecar-$label.log"
  say "== sidecar watch [$label] ${secs}s args: $*"
  "$PEAR" sidecar "$@" </dev/null >"$log" 2>&1 &
  local pid=$!
  sleep 20
  runlog "watch-$label-run" 180 "$HERE/apps/terminal" "$PEAR" run "$HERE/apps/terminal"
  local waited=20
  while [ $waited -lt "$secs" ]; do
    sleep 15; waited=$((waited + 15))
    if grep -qE 'Platform update available|Platform Force update|Applied update' "$log"; then break; fi
  done
  say "sidecar [$label] after ${waited}s: update lines:"
  grep -E 'Updating to|Switching to|update available|Force update|Applied update|Sidecar Boot|Error|error' "$log" | head -12 | sed 's/^/S1:   /'
  timeout 60 "$PEAR" sidecar shutdown </dev/null >/dev/null 2>&1
  sleep 5
  kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  say "sidecar [$label] log tail:"
  tail -6 "$log" | sed 's/^/S1:   /'
}

kill_all_pear() {
  # Throwaway VM only. No CLI call: a CLI call with no sidecar running would spawn a fresh one.
  pkill -9 -f 'bin/pear-runtime' 2>/dev/null
  pkill -9 -f 'pear-runtime-app' 2>/dev/null
  sleep 2
}

checkout_state() {
  # What is installed, read from disk without the CLI: the `current` link and the checkout file
  # pear-updater writes into the swap it applies.
  local co
  co=$(node -e "const c=require('compact-encoding');const b=require('fs').readFileSync(process.argv[1]);const s={start:0,end:b.length,buffer:b};c.fixed32.decode(s);const l=c.uint.decode(s),f=c.uint.decode(s);console.log('length '+l+' fork '+f)" "$PD/current/checkout" 2>/dev/null || echo 'no checkout file')
  say "state[$1]: current -> $(readlink "$PD/current" 2>/dev/null | sed "s#$WORK/##"); checkout: $co"
}

rl_bootstrap() {
  # Stock pear-updater-bootstrap (length 0 = latest) from our release line, into $1.
  rm -rf "$1"
  timeout 1200 node -e "require('pear-updater-bootstrap')(process.argv[1], process.argv[2]).then(() => console.log('S1: release-line bootstrap ok'), (e) => { console.log('S1: release-line bootstrap error ' + e.message); process.exit(1) })" "$RLKEY" "$1"
  local rc=$?
  mkdir -p "$1/bin" && ln -sfn "$1/$RUNTIME_REL" "$1/bin/pear"
  return $rc
}

update_trial() {
  # update_trial <label> <app run flags> [sidecar args...]
  # From a fresh release-line install: start `pear sidecar [args]`, run the terminal app,
  # publish a new release on the line, wait up to 240 s, shut the sidecar down (that is when v2
  # applies a pending platform update), then start a NORMAL sidecar for up to 150 s and shut it down.
  local label=$1 runflags=$2; shift 2
  kill_all_pear
  # A fresh install per trial: corestore refuses a copied store ("Invalid device file").
  PD="$WORK/pear-rl-$label"; PEAR="$PD/bin/pear"
  rl_bootstrap "$PD" || return 1
  checkout_state "trial $label: start"
  local log="$WORK/sidecar-trial-$label.log"
  say "== Q2 trial [$label]: sidecar args: ${*:-none}; app run flags: ${runflags:-none}"
  "$PEAR" sidecar "$@" </dev/null >"$log" 2>&1 &
  local pid=$!
  sleep 20
  runlog "trial-$label-run" 180 "$HERE/apps/terminal" "$PEAR" run $runflags "$HERE/apps/terminal"
  local before after waited=0
  before=$(grep -c '"tag":"release-line-appended"' "$WORK/rl.out")
  kill -USR2 "$RLPID"
  while [ $waited -lt 60 ]; do sleep 2; waited=$((waited + 2)); after=$(grep -c '"tag":"release-line-appended"' "$WORK/rl.out"); [ "$after" -gt "$before" ] && break; done
  grep '"tag":"release-line-append' "$WORK/rl.out" | tail -1
  waited=0
  while [ $waited -lt 240 ]; do
    sleep 15; waited=$((waited + 15))
    grep -qE 'Platform update available|Platform Force update' "$log" && break
  done
  say "trial [$label] live sidecar, after ${waited}s, update lines:"
  grep -E 'Updating to|Switching to|update available|Force update|Applied update' "$log" | head -6 | sed 's/^/S1:   /'
  timeout 60 "$PEAR" sidecar shutdown </dev/null >/dev/null 2>&1
  sleep 5; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; kill_all_pear
  grep -E 'Applied update' "$log" | head -2 | sed 's/^/S1:   /'
  checkout_state "trial $label: after its sidecar shut down"
  local log2="$WORK/sidecar-trial-$label-restart.log"
  "$PEAR" sidecar </dev/null >"$log2" 2>&1 &
  pid=$!
  waited=0
  while [ $waited -lt 150 ]; do
    sleep 15; waited=$((waited + 15))
    grep -qE 'Platform update available|Platform Force update' "$log2" && break
  done
  say "trial [$label] next normal sidecar, after ${waited}s, update lines:"
  grep -E 'Updating to|Switching to|update available|Force update|Applied update' "$log2" | head -6 | sed 's/^/S1:   /'
  timeout 60 "$PEAR" sidecar shutdown </dev/null >/dev/null 2>&1
  sleep 5; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; kill_all_pear
  checkout_state "trial $label: after a normal sidecar restart"
}

phase_terminal() {
  probe_env
  install_pinned || exit 1
  checkout_state "holepunch key, after install"
  pear_versions "after install"
  run_terminal_app
  crash_logs "after Q3a"
  say "== Q2: a normal sidecar on Holepunch's key, 240 s"
  kill_all_pear
  watch_sidecar holepunch-default 240
  kill_all_pear
  checkout_state "holepunch key, after a normal sidecar"
}

phase_trials() {
  probe_env
  need_pin
  ensure_libs
  # Q2 needs an update to arrive. Nothing newer exists on Holepunch's key, so publish the pinned
  # platform on a release line of our own (in this VM), install from it with the stock
  # bootstrapper, and push releases to it on demand.
  say "== Q2: re-home the pinned platform onto a release line we control"
  rm -rf "$WORK/rl-src" "$WORK/rl-dst" && mkdir -p "$WORK/rl-src"
  # No `timeout` wrapper: RLPID must be node itself, which takes SIGUSR2 to publish a release.
  node mirror-release-line.js "$WORK/rl-src" "$WORK/rl-dst" "$PIN_LENGTH" "$PIN_FORK" >"$WORK/rl.out" 2>&1 &
  RLPID=$!
  local waited=0
  while [ $waited -lt 1500 ] && kill -0 $RLPID 2>/dev/null && ! grep -q release-line-seeding "$WORK/rl.out"; do sleep 10; waited=$((waited + 10)); done
  say "release line ready after ${waited}s"
  grep '^S1 ' "$WORK/rl.out" | cut -c1-600
  RLKEY=$(grep -o '"tag":"release-line","t":[0-9]*,"key":"[a-z0-9]*"' "$WORK/rl.out" | grep -o '[a-z0-9]*"$' | tr -d '"')
  if [ -z "$RLKEY" ]; then say "release line: no key, stopping"; tail -5 "$WORK/rl.out" | sed 's/^/S1:   /'; return; fi

  update_trial default ""
  update_trial no-updates "--no-updates"
  local nokey
  nokey=$(node -e "console.log(require('hypercore-id-encoding').encode(require('crypto').randomBytes(32)))")
  update_trial key-unseeded "" --key "$nokey"
  kill $RLPID 2>/dev/null
}

phase_hold() {
  need_pin
  phase_terminal
  phase_stock
  phase_trials
}

pick_pkg() { local p; for p in "$@"; do apt-cache show "$p" >/dev/null 2>&1 && { echo "$p"; return; }; done; }

gui_deps() {
  say "installing xvfb, Electron's shared libraries and ffmpeg"
  # GitHub's Ubuntu image rebuilds the man-db index on every install (minutes): skip it there.
  [ -n "$SUDO" ] && $SUDO rm -f /var/lib/man-db/auto-update
  local pkgs="xvfb xauth libnss3 libgbm1 libxss1 libxtst6 libdrm2 libxkbcommon0 libatk-bridge2.0-0 libxshmfence1"
  command -v ffmpeg >/dev/null || pkgs="$pkgs ffmpeg"
  local try rc=1
  for try in 1 2 3; do
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update -qq >"$WORK/apt.out" 2>&1
    [ "$try" = 1 ] && pkgs="$pkgs $(pick_pkg libgtk-3-0t64 libgtk-3-0) $(pick_pkg libasound2t64 libasound2) $(pick_pkg libcups2t64 libcups2)"
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends $pkgs >>"$WORK/apt.out" 2>&1
    rc=$?
    say "apt install try $try exit: $rc ($pkgs)"
    [ $rc -eq 0 ] && break
    grep -E '^(E|W):' "$WORK/apt.out" | tail -4 | cut -c1-300 | sed 's/^/S1:   /'
    sleep 20
  done
}

make_fixture() {
  # H.264 High@3.1 (avc1.64001f) + AAC-LC (mp4a.40.2), fragmented for MSE.
  ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=640x360:rate=25 \
    -f lavfi -i sine=frequency=440:sample_rate=44100 -t 4 \
    -c:v libx264 -profile:v high -level 3.1 -pix_fmt yuv420p -g 25 -c:a aac -b:a 64k \
    -movflags +frag_keyframe+empty_moov+default_base_moof -y "$WORK/fixture.mp4"
  say "fixture: $(stat -c %s "$WORK/fixture.mp4") bytes, sha256 $(sha256sum "$WORK/fixture.mp4" | cut -c1-16)…, streams: $(ffprobe -v error -show_entries stream=codec_name,profile,level -of csv=p=0 "$WORK/fixture.mp4" | tr '\n' ' ')"
}

gui_run() {
  # gui_run <label> <seconds> <target> [pear run flags...]
  local label=$1 secs=$2 target=$3; shift 3
  local pslog="$WORK/ps-$label.txt"
  ( while :; do ps -eo pid,user,args | grep -E -- '--type=|pear-runtime-app' | grep -v grep >>"$pslog"; sleep 2; done ) &
  local sampler=$!
  ( cd "$HERE/apps/gui" && S1_FIXTURE="$WORK/fixture.mp4" S1_GUI_TIMEOUT_MS=180000 ELECTRON_ENABLE_LOGGING=1 timeout "$secs" \
      xvfb-run -a -s '-screen 0 1280x800x24' "$PEAR" run "$@" "$target" </dev/null >"$WORK/gui-$label.out" 2>&1 )
  local rc=$?
  kill "$sampler" 2>/dev/null; wait "$sampler" 2>/dev/null
  say "gui [$label] exit: $rc; output lines: $(wc -l <"$WORK/gui-$label.out")"
  say "gui [$label] full output (first 120 lines):"
  head -120 "$WORK/gui-$label.out" | cut -c1-16000 | sed 's/^/S1:   /'
  say "gui [$label] Electron processes seen (sampled every 2 s), by type and sandbox flags:"
  awk '{ t = "main"; f = ""; for (i = 3; i <= NF; i++) { if ($i ~ /^--type=/) t = substr($i, 8); if ($i ~ /^--(no-sandbox|enable-sandbox|disable-gpu-sandbox|no-zygote|disable-setuid-sandbox|service-sandbox-type=.*)$/) f = f " " $i } print t ":" f }' "$pslog" 2>/dev/null | sort | uniq -c | sed 's/^/S1:   /'
  return $rc
}

phase_gui() {
  probe_env
  install_pinned || exit 1
  gui_deps
  make_fixture
  ( cd "$HERE/apps/gui" && npm ci --ignore-scripts --no-audit --no-fund >/dev/null 2>&1 ); say "gui npm ci exit: $?"
  pear_versions "gui"
  say "== Q3b: preflight (syncs the pear-electron UI asset)"
  runlog gui-preflight 1500 "$HERE/apps/gui" "$PEAR" run --preflight "$HERE/apps/gui"
  local ui
  ui=$(find -L "$PD" -maxdepth 8 -path '*by-arch/linux-x64/bin/pear-runtime-app/pear-runtime' -type f 2>/dev/null | head -1)
  say "ui asset electron binary: ${ui:+${ui#$WORK/}} sha256 $( [ -n "$ui" ] && sha256sum "$ui" | cut -d' ' -f1 )"
  local who=root; [ "$(id -u)" = 0 ] || who=user
  say "== Q3b/Q4/Q5: GUI app from a local dir (default flags: pear-electron adds --no-sandbox), as $who"
  gui_run dir 300 "$HERE/apps/gui"
  crash_logs "gui dir"
  if [ "${S1_GUI_LINK:-1}" = 1 ]; then
    say "== Q3b: GUI app from a pear:// link (pear touch + pear stage)"
    runlog gui-touch 120 "$HERE/apps/gui" "$PEAR" touch --json
    local link
    link=$(grep -o 'pear://[a-z0-9]*' "$WORK/gui-touch.out" | head -1)
    say "touch link: ${link:-none}"
    if [ -n "$link" ]; then
      runlog gui-stage 600 "$HERE/apps/gui" "$PEAR" stage "$link" "$HERE/apps/gui"
      gui_run link 300 "$link" --trusted
    fi
  fi
  say "== Q5: ask for the sandbox (pear run --sandbox), as $who"
  gui_run "sandbox-$who" 240 "$HERE/apps/gui" --sandbox
  if [ "$who" = user ] && [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; then
    # Ubuntu 24.04 blocks unprivileged user namespaces for unconfined binaries; Debian does not.
    # Throwaway runner only: lift the block and ask for the sandbox again.
    $SUDO sysctl -qw kernel.apparmor_restrict_unprivileged_userns=0
    say "== Q5: --sandbox again with unprivileged user namespaces allowed (userns: $(unshare -U true 2>/dev/null && echo works || echo fails))"
    gui_run sandbox-user-userns 240 "$HERE/apps/gui" --sandbox
  fi
  current_state "end of gui"
  stop_all_pear
}

case "${1:-}" in
  drive) phase_drive ;;
  terminal) need_pin; phase_terminal ;;
  stock) probe_env; phase_stock ;;
  trials) phase_trials ;;
  hold) phase_hold ;;
  gui) phase_gui ;;
  *) echo "usage: bash run.sh drive|terminal|stock|trials|hold|gui" >&2; exit 2 ;;
esac
