# The patched AppImage runtime

An AppImage starts with a small program, the type-2 runtime, which mounts the app with FUSE. On a
machine with no usable FUSE, the upstream runtime exits before any of the app's code runs, so the
app cannot start or tell the user why. ADR 0001's amendment, item 3 requires the app to start anyway
and to tell the user how to start faster.

`nutflix-fallback.patch` changes [AppImage/type2-runtime](https://github.com/AppImage/type2-runtime)
at release `20251108` (commit `dd6cebe`) in two ways, and fixes two upstream bugs on the path they
take:

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
- **Its cleanup removes something.** In this static musl build, upstream's removal of an extraction
  removed nothing.
- **AppRun gets its arguments.** Upstream's copy of the argument list has room for its closing `NULL`
  only when `--appimage-extract-and-run` is removed from it. Started with no FUSE, or with
  `APPIMAGE_EXTRACT_AND_RUN` set, the `NULL` landed past the end, and with some argument counts the
  start failed (`Failed to run (null): Bad address`).

`build.sh` builds it from the pinned commit in a build image pinned by digest. `test.sh` proves each
behavior above on a real machine, including that a planted extraction never runs. The
`appimage-runtime` workflow runs both on x86-64 and arm64.

The app uses the build published as the prerelease `appimage-runtime-20251108-nutflix.1`, pinned by
sha256 in `maker-appimage.ts`. To change the runtime: bump `VERSION` in `build.sh`, run the workflow on
`main` so it records provenance, publish a new prerelease, and update the pins. The build is not
bit-for-bit reproducible, so a published file is verified by its attestation.
