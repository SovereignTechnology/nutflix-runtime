# S2: Pear v3 install and the update gate

Date: 2026-11-19. Question and gate: [spikes README](README.md), row S2;
[ADR 0001](../decisions/0001-a-pear-native-nutflix.md) decision 2.

## Verdict

<<PENDING verdict>>

## What ran, and where

- **Where:** a throwaway Kata VM (`kata-run --net`, the `agentrun` runner on ubuntu-server). The
  guest is Debian 12 (bookworm), kernel 6.18.63, 12 vCPU, 8 GiB. The harness runs as root with
  `NoNewPrivs: 1` and `Seccomp: 2`, on a virtiofs root. There is no `/dev/fuse`, and
  `unshare -U` fails with `EPERM` for root and for `nobody` alike.
- **Sandbox off:** every Electron run below is under Xvfb with `--no-sandbox`, because Chromium
  cannot sandbox itself in that guest (question 5). Nothing here ran on a developer machine.
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
- **Rerun:** from a checkout, `kata-run --net --no-setup --max-wait 5400 --timeout 5000 --cwd .
  -- bash spikes/s2-pear-v3/run.sh`.
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

Evidence: `results/run-full2-to-install.txt` (make to install) and `results/run-full3.txt` (the
whole flow).

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

<<PENDING q1 desktop and launch>>

## 2. What the updater events expose

<<PENDING q2>>

## 3. Reading the new build before `applyUpdate()`, and holding it

<<PENDING q3>>

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

<<PENDING q4 demo>>

From the template's `agent_docs/releases.md` (not tested here, by design: no real keys):
`request`, `verify` and `commit` refuse unless two *other* machines seed the source drive
(`SOURCE_CORE_INSUFFICIENT_PEERS`), so multisig needs at least three machines. `keys get` and
`sign` prompt for a passphrase on a TTY and fail under a pipe.

## 5. Chromium's sandbox, the launcher and FUSE

<<PENDING q5>>

## What this spike could not test

<<PENDING untested>>

## The gate's API sequence

<<PENDING sequence>>

## For the maintainer to decide

<<PENDING decisions>>
