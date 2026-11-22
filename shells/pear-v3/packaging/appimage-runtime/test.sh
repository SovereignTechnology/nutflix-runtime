#!/usr/bin/env bash
# Proves the patched runtime on a real machine with FUSE installed: a small AppImage is built around
# it and started with FUSE usable, with FUSE unusable, and against a planted extraction.
# Usage: test.sh <runtime-file>
set -euo pipefail

runtime=$(readlink -f "${1:?usage: test.sh <runtime-file>}")
T=$(mktemp -d)
planted=""
cleanup() {
  if [ -n "$planted" ]; then rm -rf -- "$planted"; fi
  rm -rf -- "$T"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "PASS: $*"; }
field() { printf '%s\n' "$1" | sed -n "s/^$2=//p" | sed -n 1p; }

magic=$(dd if="$runtime" bs=1 skip=8 count=3 2>/dev/null | od -An -tx1 | tr -d ' \n')
[ "$magic" = 414902 ] || fail "the runtime has no AppImage type-2 magic ($magic)"

mkdir "$T/AppDir"
cat >"$T/AppDir/AppRun" <<'APPRUN'
#!/bin/sh
printf 'APPDIR=%s\n' "$APPDIR"
printf 'NO_FUSE=%s\n' "${NUTFLIX_APPIMAGE_NO_FUSE:-}"
printf 'ARGC=%s\n' "$#"
for a in "$@"; do printf 'ARG=%s\n' "$a"; done
exit "${TEST_EXIT:-0}"
APPRUN
chmod 755 "$T/AppDir/AppRun"
mksquashfs "$T/AppDir" "$T/image" -root-owned -noappend -no-xattrs -comp gzip -quiet -no-progress
img="$T/Test.AppImage"
cat "$runtime" "$T/image" >"$img"
chmod 755 "$img"
md5=$(md5sum "$img" | cut -d' ' -f1)
# A PATH with no fusermount on it. AppRun above uses shell builtins only.
nofuse="$T/no-tools"
mkdir "$nofuse"

v=$("$img" --appimage-version 2>&1)
case "$v" in *-nutflix.*) pass "reports the patched build: $v" ;; *) fail "version: $v" ;; esac

out=$(env -i PATH=/usr/bin:/bin HOME="$T/h0" "$img" one 'two words')
d=$(field "$out" APPDIR)
case "$d" in /tmp/.mount_*) ;; *) fail "with FUSE, APPDIR is $d" ;; esac
[ -z "$(field "$out" NO_FUSE)" ] || fail "with FUSE, the no-FUSE notice is set"
[ ! -e "$T/h0/.cache/nutflix-runtime" ] || fail "with FUSE, it extracted anyway"
pass "FUSE usable: mounts, extracts nothing"

c="$T/c1"
out=$(env -i PATH="$nofuse" XDG_CACHE_HOME="$c" "$img" one 'two words')
d=$(field "$out" APPDIR)
[ "$d" = "$c/nutflix-runtime/appimage-$md5" ] || fail "no fusermount: APPDIR is $d"
[ "$(field "$out" NO_FUSE)" = 1 ] || fail "no fusermount: no notice"
[ "$(field "$out" ARGC)" = 2 ] || fail "no fusermount: argument count"
printf '%s\n' "$out" | grep -Fxq 'ARG=two words' || fail "no fusermount: arguments changed"
[ "$(stat -c %a "$c/nutflix-runtime")" = 700 ] || fail "the cache is not private"
[ "$(stat -c %a "$d")" = 700 ] || fail "the extraction is not private"
pass "no fusermount: runs from a private extraction, with the notice"

inode=$(stat -c %i "$d/AppRun")
env -i PATH="$nofuse" XDG_CACHE_HOME="$c" "$img" >/dev/null
[ "$(stat -c %i "$d/AppRun")" = "$inode" ] || fail "the second start extracted again"
pass "second start reuses the extraction"

rc=0
env -i PATH="$nofuse" XDG_CACHE_HOME="$c" TEST_EXIT=7 "$img" >/dev/null || rc=$?
[ "$rc" = 7 ] || fail "exit status is $rc, not 7"
pass "the app's exit status comes through"

out=$(setpriv --no-new-privs env -i PATH=/usr/bin:/bin XDG_CACHE_HOME="$T/c2" "$img")
[ "$(field "$out" NO_FUSE)" = 1 ] || fail "no_new_privs: did not fall back"
pass "no_new_privs (setuid fusermount cannot work): falls back"

out=$(env -i PATH="$nofuse" XDG_CACHE_HOME="$T/c3" "$img" --appimage-extract-and-run x)
[ "$(field "$out" APPDIR)" = "$T/c3/nutflix-runtime/appimage-$md5" ] || fail "explicit: wrong directory"
[ -z "$(field "$out" NO_FUSE)" ] || fail "explicit: notice set"
[ "$(field "$out" ARGC)" = 1 ] || fail "explicit: the switch reached the app"
pass "--appimage-extract-and-run is private too"

# What upstream would run: a same-size AppRun, already there under the predictable name.
planted="/tmp/appimage_extracted_$md5"
mkdir "$planted"
marker="$T/planted-ran"
size=$(stat -c %s "$T/AppDir/AppRun")
body=$(printf '#!/bin/sh\n: > %s\n#' "$marker")
pad=$((size - ${#body} - 1))
[ "$pad" -ge 0 ] || fail "the planted file does not fit"
{
  printf '%s' "$body"
  head -c "$pad" /dev/zero | tr '\0' '#'
  printf '\n'
} >"$planted/AppRun"
chmod 755 "$planted/AppRun"
[ "$(stat -c %s "$planted/AppRun")" = "$size" ] || fail "the planted file is the wrong size"
for args in "" "--appimage-extract-and-run"; do
  # shellcheck disable=SC2086 # empty or one switch, split on purpose
  out=$(env -i PATH="$nofuse" "$img" $args)
  d=$(field "$out" APPDIR)
  case "$d" in /tmp/nutflix-appimage.*) ;; *) fail "no cache: APPDIR is $d" ;; esac
  [ ! -e "$marker" ] || fail "the planted file ran"
  [ ! -e "$d" ] || fail "no cache: the one-run directory was left behind"
done
pass "a planted extraction in /tmp is never used; a one-run directory is removed"

c="$T/c4"
b="$c/nutflix-runtime"
mkdir -p "$b/appimage-old/sub" "$b/appimage-held" "$b/appimage-tmp.abandoned"
exec 9<"$b/appimage-held"
flock -s 9
env -i PATH="$nofuse" XDG_CACHE_HOME="$c" "$img" >/dev/null
exec 9<&-
[ ! -e "$b/appimage-old" ] || fail "another build's extraction was kept"
[ ! -e "$b/appimage-tmp.abandoned" ] || fail "an interrupted extraction was kept"
[ -e "$b/appimage-held" ] || fail "an extraction in use was removed"
pass "a new build removes old extractions, and leaves one in use"

c="$T/c5"
mkdir -p "$c" "$T/elsewhere" "$T/tmp5"
ln -s "$T/elsewhere" "$c/nutflix-runtime"
out=$(env -i PATH="$nofuse" XDG_CACHE_HOME="$c" TMPDIR="$T/tmp5" "$img")
d=$(field "$out" APPDIR)
case "$d" in "$T/tmp5/nutflix-appimage."*) ;; *) fail "symlinked cache: APPDIR is $d" ;; esac
[ -z "$(ls -A "$T/elsewhere")" ] || fail "it wrote through the symlink"
[ -z "$(ls -A "$T/tmp5")" ] || fail "symlinked cache: the one-run directory was left behind"
pass "a symlinked cache is refused"

echo "all runtime checks passed"
