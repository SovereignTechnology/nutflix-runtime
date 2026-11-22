# S2: Pear v3 install and the update gate

Date: 2026-11-19. Question and gate: [spikes README](README.md), row S2;
[ADR 0001](../decisions/0001-a-pear-native-nutflix.md) decision 2.

## Verdict

**The update gate is implementable: PASS.** On Pear 3.7.0, `pear-runtime` 1.3.1 and
`pear-runtime-updater` 3.4.0, a worker read each new build's versioned link and sha256 before
`applyUpdate()`, held builds that no notice named, kept holding across a restart, and applied
only the build whose link and hash a notice named. Evidence: job 21644, in one Kata VM. A local
file stood in for the signed Nostr notice.

**Chromium's sandbox on Debian: NOT TESTED.** The VM cannot start any Chromium sandbox, so this
part of the S2 question stays open. One finding changes ADR 0001: the AppImage's `AppRun` adds
`--no-sandbox` by itself on Ubuntu 24 and later (question 5).

| Question | Result | Basis |
|---|---|---|
| 1. Build, stage, install, launch | Works, with two template workarounds | Observed |
| 2. Updater events | `updated` has **no payload**; the state is on `pear.updater` | Observed |
| 3. Read the new build before applying | **Yes**, link and sha256 | Observed |
| 3. Withhold across a restart | **Yes**: one restart, 2 min 38 s in all | Observed |
| 3. Withhold indefinitely | Nothing in the updater applies by itself | Source only |
| 4. Provision, multisig | Dry-run provision and link derivation work; no quorum was signed | Observed in part |
| 5. Sandbox on Debian | Not tested | VM limit |

## What ran, and where

- **Where:** a throwaway Kata VM (`kata-run --net`, the `agentrun` runner on ubuntu-server). The
  guest is Debian 12 (bookworm), kernel 6.18.63, 12 vCPU, 8 GiB. The harness runs as root with
  `NoNewPrivs: 1` and `Seccomp: 2`, on a virtiofs root. There is no `/dev/fuse`, and
  `unshare -U` fails with `EPERM` for root and for `nobody` alike.
- **Sandbox off:** the app runs in the update flow are under Xvfb, as root, with `--no-sandbox`,
  because Chromium cannot sandbox itself in that guest (question 5). Nothing here ran on a
  developer machine.
- **Jobs**, all on that runner (logs in `spikes/s2-pear-v3/results/`):
  - 21567: environment, bootstrap and CLI help (`run-probe.txt`).
  - 21606: make to install (`run-full2-to-install.txt`).
  - 21637: lost to install timeouts (`run-kata-job21637-install-timeout.txt`).
  - **21644: every phase, 12 minutes (`run-kata-job21644-full.txt`).** Results below come from
    this job unless they name another. Its log omits the file list that
    `--appimage-extract-and-run` prints.
- **GitHub Actions: not used.** GitHub refused to dispatch a workflow that is not on the default
  branch (HTTP 404), and this spike does not push to `main`.
- **Pins** (`spikes/s2-pear-v3/pins.env`):
  - Template: `holepunchto/hello-pear-electron` at
    `ed067ea5d8a9b22a98a879789ef8b56bfc4acbd2` (2026-11-17, "update electron-forge dependencies
    (#99)"). Its lockfile gives `pear-runtime` 1.3.1, `pear-runtime-updater` 3.4.0, Electron
    42.11.18, `@electron-forge/cli` 8.0.1 and `pear-electron-forge-maker-appimage` 3.0.1.
  - Bootstrapper: `npx pear@3.0.0`, integrity
    `sha512-nTUqvyGrDSCNJuvaBgBbygXgKJcUVJpr9hww3/AysocUgpW5gdbV4HveXI+KxJc/Y0Rti752xP8h9LkZL4AnNw==`.
    The harness checks the registry's `dist.integrity` against this pin before running it. npx
    resolved `pear-install` 1.6.0, `hyperdrive` 13.3.4, `hyperswarm` 4.17.2 and `corestore`
    7.16.1 under it.
  - Platform: the bootstrapper pulls `pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy`
    over HyperDHT. It installed **Pear 3.7.0** (Bare 1.35.0, libuv 1.53.0, V8 14.8.178.31) as one
    99,679,496-byte ELF at `$HOME/.local/bin/pear`. `HOME` was a temporary directory in the VM.
- **Harness** (`spikes/s2-pear-v3/`):
  - `run.sh` runs the phases in order: `env deps bootstrap cli template link make1 build1 stage1
    install launch-checks run1 update2 hold restart-held wrong-notice update3 stale-notice apply
    restart-applied provision multisig-demo sandbox-nonroot`. `S2_PHASES` picks a subset.
  - `worker-instrumented.js` replaces the template's `workers/main.js`. `worker.diff` is the
    change against the template.
  - `s2.py` reads the NDJSON that the CLI and the worker write.
  - `results/` holds the run logs.
- **Rerun:** from a checkout, `kata-run --net --no-setup --max-wait 2700 --timeout 3000 --cwd .
  -- bash spikes/s2-pear-v3/run.sh`. The runner kills a job after one hour.
- **Write keys:** `pear touch` creates them in the sidecar's storage, under
  `$HOME/.config/pear`. They stayed in the VM, which was then destroyed. The harness prints links,
  which are public keys, and lists file names only, with that directory pruned.

## The platform and its CLI

```
$ pear -v
pear://0.0.smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy / v3.7.0
Key=pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy
SemVer=3.7.0
Fork=0
Length=0
```

`pear -v --json` is refused (`UNKNOWN_FLAG`). `pear info` with no link reports the platform's
upgrade lines: `production` is the key above, plus a `stage` and a `dev` key.

The subcommands, as `pear` lists them with no arguments:

```
pear touch ~ Generate a project link
pear seed ~ Seed or reseed a project
pear stage ~ Sync disk changes into project
pear build ~ Create project deployment folder
pear provision ~ Block-sync source & production
pear multisig ~ Production signing coordination
pear info ~ View project information
pear dump ~ Synchronize files from a link to a directory
pear install ~ Install applications from peers
pear data ~ Explore platform database
pear changelog ~ View project changelog
pear sidecar ~ Advanced. Run sidecar in terminal
pear identity ~ Show local network public keys
pear blind-peer ~ Manage blind peers
pear gc ~ Advanced. Clear dangling resources
pear cores ~ List platform cores
pear blind-relay ~ Run a blind relay for peers that cannot hole-punch
pear make ~ Build a Pear CLI app
pear versions ~ View dependency versions
pear help ~ View help for command
```

There is no `run`, `init` or `release`. The help text of every command is in
`results/run-probe.txt`.

**The bootstrapper fails silently.** It gives HyperDHT 30 seconds to find the platform drive.
On a timeout it prints `Network Timeout 30s` and exits with status 0
(`results/run-full1-bootstrap-timeout.txt`). The first bootstrap in this VM worked and the second
did not, so the harness retries until `$HOME/.local/bin/pear` exists.

## 1. What build, stage and install produce

Evidence: `results/run-full2-to-install.txt` (make to install; the sizes and hashes quoted here)
and `results/run-kata-job21644-full.txt` (the whole flow).

**`npm run make` fails on the template as shipped.** Forge 8.0.1 resolves every Linux maker
(AppImage, Flatpak and Snap) before it makes any, and stops with exit 1:

```
✖ Resolving make targets [FAILED: Cannot make for snap, the following external binaries need to be installed: snapcraft, lxd]
```

`npx electron-forge make --targets pear-electron-forge-maker-appimage` works (exit 0). It
downloads `appimage-12.0.1.7z` and 7-Zip from electron-builder's binaries, then writes:
- `out/HelloPear-linux-x64/`: the packaged Electron app. It holds `HelloPear` (220,253,400
  bytes), `chrome-sandbox` (15,232 bytes), `resources/` and Chromium's files.
- `out/make/HelloPear-1.0.0-x64.AppImage`: 154,159,474 bytes. Its name follows the
  `<productName>-<version>-<arch>` pattern.
- `out/make-results/<sha256>.forge-make.json`.

**`pear build` refuses Forge's file name.** The app's basename must be `productName`:

```
$ pear build --package app/package.json --linux-x64-app app/out/make/HelloPear-1.0.0-x64.AppImage --target builds/refused-1.0.0 --json
{"cmd":"build","tag":"error","data":{"success":false,"code":"ERR_INVALID_APP_NAME","message":"expected HelloPear but got HelloPear-1.0.0-x64.AppImage for linux-x64"}}
```

Copied to `dist/1.0.0/HelloPear.AppImage`, the build works. It emits `building`, then
`executable` (`file`, `origin`), then `final`. The deployment folder holds two files:

```
builds/hello-pear-electron-1.0.0/
├─ package.json                              2,470 bytes, the app's package.json verbatim
└─ by-arch/linux-x64/app/HelloPear.AppImage  154,159,474 bytes, mode 755, same sha256 as Forge's
```

**`pear touch --json`** prints one record, which holds the public key only:
`{"cmd":"touch","tag":"final","data":{"success":true,"key":"<z32>","link":"pear://<z32>"}}`.
The harness puts that link in `package.json#upgrade` before it makes the app, and keeps a
`pear seed --no-tty --json <link>` running for the whole run.

**`pear stage --json <link> <dir>`** emits these records:
- `staging`, with the verlink before the stage (`pear://0.0.<key>` on an empty drive);
- one `byte-diff` per file, the AppImage first and `package.json` second;
- `summary`: `{"files":2,"add":2,"remove":0,"change":0,"length":3,"byteLength":397,"blobs":{"length":114,"fork":0,"byteLength":154162618}}`;
- `complete`;
- `addendum`: `{"version":3,…,"verlink":"pear://0.3.<key>"}`. Its `version` is the drive's
  length, not the semver.

`--dry-run` prints the same diff and `{"tag":"skipping","data":{"reason":"dry-run"}}`.
`pear info <link>` then shows `Verlink pear://0.3.<key>`, `App hello-pear-electron@1.0.0`,
`Targets linux-x64 (154.2MB)`, `Drive Length 3`, `Drive Size 397B`, the blobs key, `Blobs Length
114` and `Blobs Size 154.2MB`, the discovery key, and `Upgrade` (the link). `pear dump --list
<link>` shows that the drive holds exactly the deployment folder:

```
/by-arch/linux-x64/app/HelloPear.AppImage
/package.json
```

**The verlink pins the db core, not the bytes.** A verlink's `<fork>.<length>` is the drive's db
core, which here has 3 blocks. The 114 blobs blocks are reached through its entries.

**`pear install <link> --json --timeout 300`** emits these records:
- `installing`: `{"link","host":"linux-x64"}`;
- `stats`, repeated: `peers` 1, and `download` bytes, blocks, speed and progress. It ran at about
  58 MB/s from the seeder in the same VM.
- `app`:
  `{"app":"HelloPear","name":"hello-pear-electron","version":"1.0.0","upgrade":"pear://<key>","verlink":"pear://0.3.<key>","key":"/by-arch/linux-x64/app/HelloPear.AppImage","tmp":"$HOME/.config/pear/gc/<random>/targets","dest":"$HOME/.local/bin/HelloPear.AppImage"}`;
- `final`: `{"success":true,"installed":1,"exists":[]}`.

The installed file has the build's sha256
(`cf213fa90028a3c9724d83abd145fa1b60e03f2dd2d89fdb09586a009d53cf8c`). It went to
`~/.local/bin` because neither `~/Applications` nor `~/AppImages` existed: pear-install 1.6.0
takes the first of the three that exists. A second `pear install` refuses (exit 1):
`Refusing to overwrite existing: …/HelloPear.AppImage / To reinstall, manually remove then rerun
command`.

**Finding the seeder was unreliable in this VM.** The seeder and the installer were two firewalled
peers on one host. Job 21637 lost three 300-second installs to `ERR_NETWORK_TIMEOUT`. In job 21644
two 90-second attempts timed out, and the first attempt after restarting `pear seed` worked. That
order does not prove the restart was the cause.

**What `pear install` adds on Linux:**
- Six `hicolor` icons under `~/.local/share/icons`.
- `~/.local/share/applications/HelloPear.desktop`, **only if that directory already exists**. In
  job 21606 it did not, and the install reported success without the file. npm's `pear-install`
  1.6.0 explains it: its `_move` ignores `ENOENT`. The platform bundles its own copy, which was
  not compared.

```
[Desktop Entry]
Name=HelloPear
Exec=/var/tmp/s2/home/.local/bin/HelloPear.AppImage
Terminal=false
Type=Application
Icon=HelloPear
StartupWMClass=hellopear
X-AppImage-Version=1.0.0
Comment=
Categories=Utility
MimeType=x-scheme-handler/hello-pear-electron
```

`Exec` has no `%U` although the entry claims a URL scheme, so a launcher has no URL to pass. That
is read from the file; no deep link was tried.

**Launching it:**
- As is, it needs FUSE 2. Its runtime loads `libfuse.so.2`, and without it the app exits 1 with
  `dlopen(): error loading libfuse.so.2`.
- With `--appimage-extract-and-run`, as root and without `--no-sandbox`, Electron exits 127:
  `Running as root without --no-sandbox is not supported`.
- With `--appimage-extract-and-run --no-sandbox`, it runs, and its worker starts with
  `app = <the installed AppImage>` and `bundled = true`.

## 2. What the updater events expose

**`pear.updater` emits everything about updates.** `pear` itself emitted only `ready`. The template
also listens for `minver-required` on it, which `pear-runtime` 1.3.1 does not emit.

| Event on `pear.updater` | Payload observed | When |
|---|---|---|
| `update-scheduled` | a number, the delay in ms (`1224`) | on an append to the drive |
| `updating` | **none** | a higher semver is on the drive |
| `updating-progress` | `{ peers, download: { bytes, blocks, speed, progress }, upload: { bytes, blocks, speed } }` | during the mirror |
| `updating-delta` | `{ op: "add", key: "/by-arch/linux-x64/app/HelloPear.AppImage", bytesRemoved: 0, bytesAdded: 154159477 }` | per file |
| `updated` | **none** | the build is on disk |
| `error` (from the source; not seen) | an `Error` | a check failed |

**No event carries the versioned link, the version or a hash.** At `updated`, the updater's fields
held this for build 1.0.1:

```
next         <dir>/pear-runtime/next/5.0      directory named <length>.<fork>
nextVersion  1.0.1
length       5
updated      true
updating     false
applied      false
bundled      true
app          <the installed AppImage>
```

Three traps:
- **`next/<length>.<fork>` is the reverse of a verlink** (`pear://<fork>.<length>.<key>`).
- **`next` holds only the artifact**, not `package.json`.
- **`entry.value.blob.byteLength` is not the file size.** For the 154 MB AppImage it was 668, with
  `blockMap: true`. Take the size from the mirrored file or from `updating-delta`.

`updating-progress` is not a completion signal: its last value before `updated` was 0.045 for
1.0.1 and 0.054 for 1.0.2. In the 60 seconds after start the check runs at once, while
`update-scheduled` still reports the drawn delay. Both updates here fell in that window.

**What the template exposes.** Its worker sends the renderer the strings `update-scheduled <ms>`,
`updating`, `updated` and `updater-error <message>`. Its preload offers `bridge.applyUpdate()`,
which reaches `pear.updater.applyUpdate()` with no check, and `bridge.appAfterUpdate()`, which
relaunches. **It exposes no link, version or hash, so the app must add:**
- in the worker, the candidate and gate below, replacing the `pear:applyUpdate` handler;
- direct dependencies on what the gate imports (`pear-link`, `hypercore-id-encoding`, `b4a` and a
  sha256), which resolved only transitively here;
- in the preload, a read-only update status (state, version, link, hash, reason held), and no
  `applyUpdate`;
- in the main process, a relaunch only after the worker reports a verified apply, and no
  forwarding of `--no-sandbox`: the template's relaunch passes on `process.argv`.

## 3. Reading the new build before `applyUpdate()`, and holding it

**Yes, by two routes, and both gave the build's real sha256:**
- **From the drive, before the mirror finishes:** `drive.checkout(length)`, `get('/package.json')`
  and a hash of `createReadStream('/by-arch/<host>/app/<name>')`. For 1.0.1 and 1.0.2 this finished
  before `updated` fired, in about 950 ms.
- **From the mirrored file, after `updated`:** a hash of
  `<next>/by-arch/<host>/app/<name>`, in about 850 ms. **The gate should use this one**, because it
  is the file `applyUpdate()` swaps in.

| Phase | Notice | What the gate did | Installed |
|---|---|---|---|
| `update2`, `hold` | none | held 1.0.1: `no release notice names this build` | 1.0.0 |
| `restart-held` | none | mirrored 1.0.1 again, held it again | 1.0.0 |
| `wrong-notice` | 1.0.1, wrong sha256 | held: `sha256 mismatch` | 1.0.0 |
| `update3` | the same | moved to 1.0.2, held: the notice names `pear://0.5.…` | 1.0.0 |
| `stale-notice` | 1.0.1, correct sha256 | did not apply | 1.0.0 |
| `apply` | 1.0.2, correct sha256 | applied; the installed hash matched | **1.0.2** |
| `restart-applied` | | new process reports 1.0.2, no `updating` | 1.0.2 |

In `stale-notice` the worker wrote no new record, because its log drops a repeated reason. The
proof is that no `gate-apply` appears and the installed hash did not change.

**A held update on restart.** The installed file stayed at 1.0.0 through the stop and the start.
The new process replaced `pear-runtime/next/5.0`, then emitted `updating` and `updated` again with
`peers: 0` and 0 bytes downloaded, before its first connection: the build came from the local
corestore. The gate saw it and held it again. Nothing records an approval between runs, so the
gate decides afresh on every start.

**How long it can be withheld.** Observed: 2 minutes 38 seconds across one restart, from the first
`updated` to `gate-apply`. Beyond that, from the source: `applyUpdate()` has no caller inside
`pear-runtime` or `pear-runtime-updater`, so a build stays unapplied until the app calls it.

**The updater holds only the newest build.** Once 1.0.2 was mirrored, a correct notice for 1.0.1
could no longer apply. So a release notice must name the newest build on the link, and a newer
build with no notice blocks an older announced one for clients that have mirrored it.

**After the apply**, `next/7.0` was gone but the superseded `next/5.0` (154 MB) was still on disk.
From the source, it goes at the next start.

## 4. `pear provision` and `pear multisig`

Help text, verbatim from Pear 3.7.0 (each command also takes `--help|-h`):

```
pear provision [flags] <source-verlink> <target-link> <production-verlink>
Block-sync source & production
Synchronize blocks from a source link to a pre-production target link.
The target can then be multisig'd against a production link.
Use pear touch to generate the target link first.
Arguments:
  <source-verlink>       Versioned source link
  <target-link>          Target link to sync to, as generated by pear touch
  <production-verlink>   Versioned production link to sync against
Flags:
  --dry-run|-d           Execute provision to a disposable target
  --json                 Newline delimited JSON output
```

```
pear multisig [flags] [command]
Production signing coordination
Quorum-based cryptographic cosigning for production releases.
Gather enough signatures to approve a release to synchronize
onto a production link.
Example - 2/3 must sign to approve
pear.json: {
  "multisig": {
    "publicKeys": ["<pubkey1>", "<pubkey2>", "<pubkey3>"],
    "namespace": "my-org/my-app",
    "quorum": 2
  }
}
Commands:
  keys        Manage signing keys
  link        Print project multisig link
  request     Create a multisig request
  sign        Sign a multisig request
  verify      Verify multisig request & responses
  commit      Commit multisig to go live
```

```
pear multisig keys [flags] [command]
Manage signing keys
Commands:
  get         Get signing key, initializing if needed
  paths       Print paths to public & private key files
  list        List signing keys
  add         Add signing keys
  remove      Remove signing keys

pear multisig keys get [flags] [name=default]
Get signing key, initializing if needed
Idempotent.
Creates a public/private keypair if one doesn't already exist.
Always prints the public key.
Arguments:
  [name=default]   Optional. Key identifier for the keypair's on-disk names. Defaults to "default"
Flags:
  --secret         Also print the private key in plain text — make sure nobody can see your screen
  --json           Newline delimited JSON output

pear multisig keys paths [flags] [name=default]
Print paths to public & private key files

pear multisig keys list [flags]
List signing keys
Output all names and public keys

pear multisig keys add [flags] <name> <public-key> [private-key]
Add signing keys
Import a signing keypair or add a known public key
Arguments:
  <name>          Name to store this key under. Must not already exist
  <public-key>    Public key — a key path or key string
  [private-key]   Optional. Private key — a key path or key string. A path avoids leaving it in shell history. Omit for public-key only

pear multisig keys remove [flags] <name>
Remove signing keys
Arguments:
  <name>      Name of the key to remove. Permanent — no confirmation, no backup
```

```
pear multisig link [flags]
Print project multisig link
The multisig link is derived from the publicKeys, quorum and
namespace fields of your project's pear.json.
Flags:
  --config [./pear.json]   Path to the project's pear.json. Defaults to ./pear.json
  --vanity <vanity>        Generate a link starting with this z32 prefix
  --json                   Newline delimited JSON output

pear multisig request [flags] <verlink>
Create a multisig request
Create a signing request to synchronize a versioned source link
onto the project's multisig link, as printed by pear multisig link.
Arguments:
  <verlink>                              Versioned source link to sign off
Flags:
  --force                                Skip sanity checks
  --config [./pear.json]                 Path to the project's pear.json. Defaults to ./pear.json
  --peer-update-timeout <milliseconds>   How long to wait for peers to update, in milliseconds
  --json                                 Newline delimited JSON output

pear multisig sign [flags] <request> [name=default]
Sign a multisig request
Sign a multisig request using a local signing key.
The key's public counterpart must be listed in the
multisig.publicKeys field of the pear.json at the source link
supplied to pear multisig request.
Arguments:
  <request>        As returned by pear multisig request
  [name=default]   Optional. Local key to sign with, by name. Defaults to "default"

pear multisig verify [flags] <source-link> <request> [...responses]
Verify multisig request & responses
Verify inputs and perform a commit dry run
Flags:
  --config [./pear.json]                 Path to the project's pear.json. Defaults to ./pear.json
  --peer-update-timeout <milliseconds>   How long to wait for peers to update, in milliseconds
  --json                                 Newline delimited JSON output

pear multisig commit [flags] <source-link> <request> [...responses]
Commit multisig to go live
Apply signatures to allow sync from source drive to multisig drive
Flags:
  --config [./pear.json]                 Path to the project's pear.json. Defaults to ./pear.json
  --peer-update-timeout <milliseconds>   How long to wait for peers to update, in milliseconds
  --json                                 Newline delimited JSON output
```

**What multisig needs in the project:**
- `pear.json` holds `multisig.publicKeys` (z32 signing public keys), `multisig.namespace` and
  `multisig.quorum`. The template ships exactly that, with placeholders:
  `{"multisig":{"publicKeys":["<PUBKEY_HERE>","<PUBKEY_HERE>","<PUBKEY_HERE>"],"namespace":"holepunchto/hello-pear-electron","quorum":2}}`.
  The production link is derived from those three fields, so any edit to them gives a new link
  (template `agent_docs/releases.md`; demonstrated below).
- `package.json#upgrade` is the link that builds follow: a stage link for developers, the
  provision link for previews, the multisig link for production. `package.json#version` must
  rise for an update to be taken.
- `pear build --config <pear.json>` copies `pear.json` into the deployment folder. `verify` and
  `commit` read `./pear.json` unless given `--config`.

**Demonstrated in job 21644, with throwaway keys:**
- `pear provision --dry-run --json <1.0.2 verlink> <new link> pear://0.0.<new key>` exited 0. It
  emitted `syncing`, `synced`, `diffing`, one `byte-diff` per file, `diffed` (2 changes, semver
  1.0.2, the source and target core hashes), `dry` and `final`.
- `pear multisig link` printed one link for a three-key, quorum-2 `pear.json`. Changing only
  `namespace` printed a different link.
- `pear multisig request <verlink>` refused with exit 1:
  `SOURCE_CORE_INSUFFICIENT_PEERS: Source core is not well seeded (1/2 peers)`.

`sign`, `verify` and `commit` were not run.

From the template's `agent_docs/releases.md` (`request` confirmed above, the rest not tested):
`request`, `verify` and `commit` refuse unless two *other* machines seed the source drive
(`SOURCE_CORE_INSUFFICIENT_PEERS`), so multisig needs at least three machines. `keys get` and
`sign` prompt for a passphrase on a TTY and fail under a pipe.

## 5. Chromium's sandbox, the launcher and FUSE

**Not answered for Debian.** The guest has `NoNewPrivs: 1`, seccomp, no `/dev/fuse` and no user
namespaces (`unshare -U` fails with `EPERM`), so no Chromium sandbox can start in it, on any
distribution.

**What the VM did show, as a non-root user with no `--no-sandbox`:**
- Run as is: exit 1, `dlopen(): error loading libfuse.so.2`.
- With `--appimage-extract-and-run`: exit 127. **Chromium failed closed:** `The SUID sandbox helper
  binary was found, but is not configured correctly. Rather than run without sandboxing I'm
  aborting now.`

**`AppRun` turns the sandbox off on Ubuntu 24 and later.** The AppImage's launcher script, from
electron-builder's template, contains:

```bash
EXTRA_ARGS=""
if [ -f /etc/os-release ]; then
  . /etc/os-release
  if [ "$ID" = "ubuntu" ] && [ "${VERSION_ID%%.*}" -ge 24 ] 2>/dev/null; then
    EXTRA_ARGS="--no-sandbox"
  fi
fi
```

It then runs `exec "$BIN" $EXTRA_ARGS "${args[@]}"`. This was read from the built AppImage and not
run on Ubuntu. So ADR 0001's "cannot start Chromium's sandbox there" understates it: as shipped,
the app would **start without the sandbox and say nothing**. Its refusal has to be written:
`app.commandLine.hasSwitch('no-sandbox')` in the main process, before any window opens. The
check is proposed here and was not run.

On Debian the script adds no flag, so Chromium needs a working user namespace or a root-owned
setuid `chrome-sandbox`. The AppImage's copy has mode 755, with no setuid bit, so in practice that
means user namespaces.

## What this spike could not test

- **Chromium's sandbox on any real desktop**, Debian or Ubuntu, and a FUSE launch.
- **A real release notice:** a local JSON file stood in for the signed kind-30071 event.
- **A real multisig release:** `sign`, `verify`, `commit`, and an update through a multisig link.
- **Holding for longer** than 2 min 38 s, or across more than one restart.
- **The delayed path:** both updates arrived within 60 s of start, so the random delay never ran.
- **A drive fork:** every link here had fork 0, so parsing `<length>.<fork>` with a non-zero fork
  is unproven.
- **`skipUpdate` returning `true`:** the hook was observed being called, and always returned
  `false`.
- **A second `applyUpdate()` in one process.** From the source, it returns without swapping.
- **An app on a different filesystem from its storage**, where the atomic swap may not work.
- **The template's own update button and relaunch:** the instrumented worker refuses that path,
  and the harness restarted the app itself.
- **Discovery by topic alone:** the worker also joined the seeder by its swarm key, and the log
  does not show which path made the connection.
- **macOS, Windows, arm64**, and peers on different networks.

## The gate's API sequence

All of it runs in the Bare worker, which owns the updater. The renderer only shows state.

1. **Start.** The main process passes the worker `[updates, version, upgrade,
   '<productName>.AppImage', dir, process.env.APPIMAGE]`, as the template does. The worker builds
   `new PearRuntime({ updates, version, upgrade, name, dir, app, store, swarm })` and joins
   `pear.updater.drive.core.discoveryKey`. `app` must be the AppImage's path: from the source,
   without it `bundled` is false and the updater never checks.
2. **Listen on `pear.updater`.** Forward `update-scheduled`, `updating` and `updating-progress` to
   the renderer as status only.
3. **On `updated`, build the candidate from the updater's state**, not from `drive.core.length`,
   which may have moved on:

   ```js
   const next = pear.updater.next
   const [length, fork] = path.basename(next).split('.').map(Number)
   const verlink = pearLink.serialize({ drive: { fork, length, key: pear.updater.drive.key } })
   const version = pear.updater.nextVersion
   const file = path.join(next, 'by-arch', platform + '-' + arch, 'app', name)
   const sha256 = await sha256File(file)
   ```

4. **Fetch the release notice** (kind 30071, signed by the SovTech key, `d = nutflix-runtime`).
   Compare its versioned link, and its sha256 for this host, with the candidate. On no notice or
   any mismatch, hold, and tell the renderer why.
5. **Apply only on a match.** Hash `file` again. Then, with no `await` in between, check
   `pear.updater.next === candidate.next` and call `pear.updater.applyUpdate()`, which reads
   `this.next` synchronously.
6. **Prove it.** Await the call, then hash `pear.updater.app` and compare with the candidate. From
   the source, `applyUpdate()` returns without error and without swapping when `updated` is false,
   `applied` is true or the app is not bundled, so only the hash proves the swap.
7. **Offer a restart.** The main process relaunches the AppImage, without `--no-sandbox`. From the
   source, one process can apply once: `applied` stays true.
8. **Never let the renderer call `applyUpdate()`.** The gate replaces the template's
   `pear:applyUpdate` handler.
9. **On every start, decide again.** The updater mirrors the held build again from local storage
   and fires `updated`, so steps 3 to 6 repeat.

## For the maintainer to decide

1. **Ubuntu 24 and later.** Keep ADR 0001's position and refuse to run when `--no-sandbox` is
   present, which makes those systems unsupported? Or ship a changed `AppRun`? Either way, the
   ADR's consequence should say that the stock AppImage disables the sandbox there.
2. **Where to answer the Debian sandbox question.** It needs a Debian machine or VM with user
   namespaces and without `NoNewPrivs`. GitHub Actions needs a dispatch workflow on `main` first;
   `spikes/s2-pear-v3/github-workflow.yml` is one, inert where it is and never run. Until this is answered, the
   sandbox part of S2 stays open.
3. **FUSE 2.** The AppImage needs `libfuse.so.2`. Document it as a requirement, or launch with
   `--appimage-extract-and-run`, which unpacks the app on each start?
4. **A newer build with no notice blocks an older announced one.** Accept this, given that only a
   multisig quorum can write the production link? The gate cannot pick an older build.
