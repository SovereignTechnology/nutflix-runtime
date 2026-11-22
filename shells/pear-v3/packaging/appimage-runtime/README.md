# The patched AppImage runtime

An AppImage starts with a small program, the type-2 runtime, which mounts the app with FUSE. On a
machine with no usable FUSE, the upstream runtime exits before any of the app's code runs, so the
app cannot start or tell the user why. ADR 0001's amendment, item 3 requires the app to start anyway
and to tell the user how to start faster.

`nutflix-fallback.patch` changes [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime)
at release `20251108` (commit `dd6cebe`) in two ways:

- **It falls back by itself.** With no setuid `fusermount`, no usable `/dev/fuse`, or `no_new_privs`
  set, it extracts and runs instead of exiting. It sets `NUTFLIX_APPIMAGE_NO_FUSE=1` so the app can
  show the notice.
- **It extracts privately.** Upstream's `--appimage-extract-and-run` uses a predictable name in the
  shared temp directory, trusts a directory already there, and keeps any file whose size matches, so
  another local user could plant the code that runs next. Here the extraction goes to
  `~/.cache/nutflix-runtime/appimage-<md5>` (mode 0700) and appears under that name only once it is
  complete. It is kept per build, so only the first start is slow. A new build removes older
  extractions unless a running copy holds them. With no usable cache directory, it uses a new private
  directory for that one run and removes it afterwards.

`build.sh` builds it from the pinned commit in a build image pinned by digest. `test.sh` proves each
behavior above on a real machine, including that a planted extraction never runs. The
`appimage-runtime` workflow runs both on x86-64 and arm64.

The app does not use this runtime yet: `maker-appimage.ts` still pins the upstream one. The next step
publishes the built runtime with build provenance and pins it there by sha256.
