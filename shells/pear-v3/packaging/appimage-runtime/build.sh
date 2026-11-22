#!/usr/bin/env bash
# Builds the patched AppImage type-2 runtime for one architecture, from a pinned upstream commit,
# in a build image pinned by digest. Upstream's own scripts do the build; its source tarballs are
# pinned by sha256 there. Usage: build.sh <x86_64|aarch64> <out-dir>
set -euo pipefail

UPSTREAM=https://github.com/AppImage/type2-runtime.git
# Release 20251108.
COMMIT=dd6cebedcbddde9c82f89b011e8e1d40b6e43868
ALPINE=alpine:3.21@sha256:bc21487101ae47172509130ee1092cc273a831968d64b617776d1f69c81e42ab
# Bump with every change to nutflix-fallback.patch: `--appimage-version` prints it.
VERSION="type2-${COMMIT:0:7}-nutflix.1"

arch=${1:?usage: build.sh <x86_64|aarch64> <out-dir>}
case "$arch" in x86_64 | aarch64) ;; *)
  echo "unsupported architecture: $arch" >&2
  exit 2
  ;;
esac
mkdir -p "${2:?usage: build.sh <x86_64|aarch64> <out-dir>}"
out=$(readlink -f "$2")
here=$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")

src=$(mktemp -d)
trap 'rm -rf -- "$src"' EXIT
git -C "$src" init -q
git -C "$src" fetch -q --depth 1 "$UPSTREAM" "$COMMIT"
git -C "$src" -c advice.detachedHead=false checkout -q FETCH_HEAD
test "$(git -C "$src" rev-parse HEAD)" = "$COMMIT"

git -C "$src" apply --whitespace=error-all "$here/nutflix-fallback.patch"

dockerfile="$src/scripts/docker/Dockerfile"
sed -i "s|^FROM alpine:3\.21\$|FROM $ALPINE|" "$dockerfile"
grep -Fxq "FROM $ALPINE" "$dockerfile"
printf '%s' "$VERSION" >"$src/src/runtime/version"

# The container's working directory is the source, and `out/` there is the current directory.
cd "$out"
ARCH=$arch bash "$src/scripts/docker/build-with-docker.sh"

test -s "$out/runtime-$arch"
sha256sum "runtime-$arch"
