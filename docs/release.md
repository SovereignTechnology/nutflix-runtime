# Releasing nutflix-runtime

The runbook for shape (a) of [ADR 0001](decisions/0001-a-pear-native-nutflix.md): a Pear v3 app, five
targets on one `pear://` link, updated only when a signed release notice names the build.

Every step is marked:

- **tool**: `shells/pear-v3/scripts/release/cli.ts` does it, locally. It changes no link.
- **owner**: only a person holding the release authority does it. Where the tool has a command for
  it, the tool prints the exact command by default (a dry run), and runs it only with `--execute`
  and the link typed back on a terminal.
- **each signer**: every member of the quorum, on their own machine.

The tool never reads, stores or prints a signing key. Multisig keys stay in each signer's own
`~/.pear`, and the Nostr release key stays in the owner's signer.

```sh
alias release='node shells/pear-v3/scripts/release/cli.ts'   # from the repository root
```

It needs Node 22.18 or later, the [`gh` CLI](https://cli.github.com/) signed in to github.com (it
reads the GitHub API and downloads artifacts; the tool always asks github.com, whatever `GH_HOST`
says, and never sees the token), `unzip`, `unsquashfs` (the
`squashfs-tools` package) and Linux or macOS: a Windows file system cannot keep a macOS bundle's
symlinks. Every `pear` command it runs is the pinned CLI (3.7.0, checked against the sha256 in
`scripts/pear-ci/pins.ts`), kept in `~/.cache/nutflix-release/`. A Pear sidecar that is already
running keeps serving whatever CLI talks to it, so stop any other one first: `pear sidecar shutdown`.

## What the checks are, and what they are not

- **What ties a release to reviewed code is where it came from.** `check` asks GitHub that the run is
  this repository's `ci.yml`, a push to `main`, at the commit you name, and successful; that the
  commit is in `main`'s history; and that no tag named `main` exists (a tag's runs report it as
  their branch). It holds each artifact to the digest GitHub reports for that run. If GitHub cannot
  be reached it refuses; there is no offline path.
- **Everything else is a check against a mistake, not against hostile code.** `verify-root`, the
  baked commit, main's updates switch and the CPU check read what a build declares. Hostile code can
  declare the right values and do something else. `--execute`, the typed-back link and the refusal
  on CI stop a slip: anything already running on your machine can unset `CI` or fake a terminal.
- **The rule for runners:** nothing on a runner can reach the public DHT, and a build carrying the
  production link is never launched there. A `test` build with a throwaway link is launched: its
  DHT is forced to `127.0.0.1` by the trust-root parser, and a firewall rule counts packets to the
  public addresses and fails the job on any.

## Once: the signers and the production link

| #   | Who         | What                                                                                                                                                                                                                                                                                                                                  |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | each signer | `pear multisig keys get <name>`. It asks for a password that cannot be recovered, and prints the public key.                                                                                                                                                                                                                          |
| 2   | owner       | Write `pear.json` with the public keys, a quorum and a namespace (below). The link is derived from all three: changing any of them is a different link. Give every signer the same file.                                                                                                                                              |
| 3   | owner       | `pear multisig link --config pear.json` prints the **production link**.                                                                                                                                                                                                                                                               |
| 4   | owner       | Set `RELEASE_UPGRADE_LINK` to it, in a reviewed commit ([The day the link is set](#the-day-the-link-is-set)).                                                                                                                                                                                                                         |
| 5   | owner       | In nutflix-pear, set `RUNTIME_PRODUCTION_LINK` to the same link, in a reviewed commit, and move this repository's `vendor/nutflix-pear` submodule to a commit that has it. Until then its publish script refuses this app's notices.                                                                                                  |
| 6   | owner       | Once there is an Apple Developer account and a Windows code-signing certificate: pin them in `scripts/release/signing-policy.ts` (`APPLE_TEAM_ID`, `WINDOWS_SIGNER`), in a reviewed commit. **Until `APPLE_TEAM_ID` is pinned, `multisig commit` and `notice-draft` refuse every release** ([Releasing macOS ad hoc](#releasing-macos-ad-hoc)), and a signer accepts only an ad-hoc macOS signature and no signed `.msix` ([What a signature may say](#what-a-signature-may-say)). |

```json
{
  "multisig": {
    "publicKeys": ["<signer 1>", "<signer 2>", "<signer 3>"],
    "namespace": "<a name for this app's release line>",
    "quorum": 2
  }
}
```

macOS needs Apple signing and notarization and Windows a real certificate before these builds run
on other people's machines (ADR 0001, amendment, item 5). The MSIX publisher in
`packaging/identity.ts` must equal the certificate's subject, and then never change.

While `RELEASE_UPGRADE_LINK` is `null`, the steps on a real link and `notice-draft` refuse: a build
from that source starts no updater, so nothing released from it could ever be updated.

## Every release

### Build

| #   | Who   | Command                                                                                                                  |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------ |
| 1   | owner | Set the version in `shells/pear-v3/package.json`, merge, and wait for CI on `main`. Note the run id and the full commit. |
| 2   | tool  | `release download --run <run id> --commit <sha> --artifacts artifacts`                                                   |
| 3   | tool  | `release check --run <run id> --commit <sha> --artifacts artifacts`                                                      |
| 4   | tool  | `release assemble --run <run id> --commit <sha> --artifacts artifacts --out rel`                                         |

`release-<target>` artifacts exist only for a push to `main` of a source with a production link. A
pull request's build never produces one, and `check` refuses any other run.

`check` refuses unless all five packages are there, are the artifacts GitHub holds for that run, are
one version, carry the commit you named, hold exactly the production root, and are built for their
CPU. It unpacks each one and reads the result, and runs none of them. A zip with a duplicate or
ambiguous entry is refused, and a macOS bundle must unpack to the exact tree the Mac runner zipped.
`assemble` records each package's digest in `rel/release.json`, and later steps compare against that
record rather than trusting the files in `rel/`.

### Sign (macOS and Windows)

| #   | Who   | Command                                                                                                                   |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| 5   | owner | Copy each macOS bundle and the `.msix` out of `rel/apps/<target>/`, and sign, notarize and staple **the copy**, as below. |
| 6   | tool  | `release record-signed --out rel --target <target> --signed <path to the signed Nutflix.app or Nutflix.msix>`             |

`record-signed` checks that CI's package is still what `check` read, then that the signed one is
that package **with signatures added and nothing else changed**: every file, symlink and executable
bit equal, Mach-O code equal once the signature is taken out, every part of an `.msix` equal except
its signature. It reads the root, version, commit and CPU again from the signed tree, and records
both digests. CI's digest stays the reference and is never regenerated from a signed bundle.

#### What a signature may say

The signatures themselves are pinned in `scripts/release/signing-policy.ts`, and `record-signed` and
every signer's `verify-request` hold every Mach-O in a signed bundle to it, re-signed or not:

- **macOS, what a signature says:** the Apple Team ID (`APPLE_TEAM_ID`; while it is `null`, only an
  ad-hoc signature is accepted), the hardened runtime on every executable, and exactly the
  entitlements the policy names for each binary: `com.apple.security.cs.allow-jit` for the app, its
  helpers and the Bare runtime, and none for anything else. A signature that adds an entitlement
  (say `get-task-allow`), drops the hardened runtime, or comes from another team is refused. Only a
  bundle's own `Contents/_CodeSignature/`, a framework version's `_CodeSignature/` and the stapled
  `Contents/CodeResources` may be added.
- **macOS, ad hoc only: library validation off on three binaries.** The hardened runtime turns on
  library validation, which lets a process load only Apple's libraries and those of its own Team
  ID. Ad-hoc code has no Team ID, so an ad-hoc app with the hardened runtime cannot load its own
  Electron Framework, nor Bare its addons ([Apple DTS](https://developer.apple.com/forums/thread/782645):
  "you can only load platform libraries"). So while `APPLE_TEAM_ID` is `null`, the app, its helpers
  and `bare` also carry `com.apple.security.cs.disable-library-validation`
  (`packaging/entitlements.mac.adhoc.plist`), and nothing else does. Once a Team ID is pinned,
  every library carries that team's signature, library validation stays on, and that entitlement is
  refused (`packaging/entitlements.mac.plist`).
- **macOS, whether it is valid:** every code directory must hash each page of its binary's code as
  it is, and each special slot it fills must hash what that slot names: the bundle's `Info.plist`
  and resource seal (`_CodeSignature/CodeResources`) for a bundle's main executable, the
  requirements, and both forms of the entitlements. A blob the directory does not bind is refused.
  This is what the kernel checks when the code runs, and the tool checks it on any OS. It was checked
  in a VM against real signatures: Pear 3.7.0's Developer ID-signed macOS binaries (both CPUs, a
  changed byte refused), every Mach-O of Electron 45.2.1's macOS release, and every Mach-O of a
  Developer ID-signed app bundle with an embedded framework, helper app and XPC services (a changed
  `Info.plist` or resource seal refused). It does not
  check the resource seal's contents, the nested code it names, or an identity's CMS signature and
  its chain to Apple: on a Mac, `verify-request` also runs `codesign --verify --strict --deep`,
  which does; elsewhere it says plainly that this was not checked. While no Team ID is pinned there
  is no CMS to check. **Once one is, at least one signer in the quorum must run `verify-request`
  on a Mac**: off a Mac it then refuses and prints no sign line, unless the signer passes
  `--without-apple-check` to say another signer did ([step 14](#step-14-is-what-the-quorum-is-for)).
- **macOS, what kind of binary:** a Mach-O must be 64-bit and little-endian, thin or universal
  (`fat` or `fat64`, both read), with only 64-bit slices. A 32-bit one is refused outright: macOS
  has not run 32-bit code since 10.15, and this app ships for arm64 and x64.
- **Windows:** the certificate (`WINDOWS_SIGNER`: its SHA-256, subject and issuer; while it is
  `null`, a signed `.msix` is refused). `[Content_Types].xml` may change only by the entries that
  declare the signature and the code-integrity catalog. A catalog signing adds must be signed by the
  same certificate, and every member must be the Authenticode digest of a binary in the package.

Sign inside out, ad hoc today, with `--sign "Developer ID Application: …" --timestamp` in place of
`--sign -` once a Team ID is pinned (the CI proof signs exactly this way, `prove-signing.ts`):

1. every Mach-O in the bundle but the app's own executable, each on its own (the order does not
   matter: no bundle is sealed yet): this reaches what `--deep` does not, such as the node modules' native addons (`.node`, `.bare`), the
   Bare runtime and a framework's tools (`ShipIt`). Only the helpers' executables and `bare` get the
   entitlements file;
2. the nested code in bundle locations, `--deep`, which seals each framework and helper;
3. each helper app, with the entitlements file;
4. the app, with the entitlements file.

Every Mach-O must be signed this way: the tool holds each one to the policy, and an executable left
as CI built it has no hardened runtime.

```sh
E=shells/pear-v3/packaging/entitlements.mac.adhoc.plist   # entitlements.mac.plist once a Team ID is pinned
find Nutflix.app -type f ! -path 'Nutflix.app/Contents/MacOS/Nutflix' -print0 |
  while IFS= read -r -d '' f; do
    file -b "$f" | grep -q '^Mach-O' || continue
    case "$f" in
      */node_modules/bare-sidecar/prebuilds/darwin-*/bare | \
        Nutflix.app/Contents/Frameworks/Nutflix\ Helper*.app/Contents/MacOS/*) ent=(--entitlements "$E") ;;
      *) ent=() ;;
    esac
    codesign --force --options runtime "${ent[@]}" --sign - "$f"
  done
codesign --force --deep --options runtime --sign - Nutflix.app
for h in Nutflix.app/Contents/Frameworks/Nutflix\ Helper*.app; do
  codesign --force --options runtime --entitlements "$E" --sign - "$h"
done
codesign --force --options runtime --entitlements "$E" --sign - Nutflix.app
codesign --verify --strict --deep Nutflix.app
```

**Real certificates are unproven.** CI runs this step with an ad-hoc signature on macOS and a
certificate made for the job on Windows. Apple's Developer ID signing, notarization, stapling and a
certificate authority's certificate have never been through it. If a real tool changes something
else, `record-signed` refuses and names the file: that is the point to stop and look.

Without this step a target would ship as CI built it. **For macOS the tool refuses that:**
`multisig commit` and `notice-draft` stop if a macOS row of `release.json` has no signed package,
because CI's own build has no hardened runtime. For Windows, CI's unsigned `.msix` does not install
for users.

#### Releasing macOS ad hoc

While `APPLE_TEAM_ID` is `null`, `multisig commit` and `notice-draft` refuse every release: the
approved plan ships test builds only until Apple signing exists. Only the owner can change that, in
a reviewed commit that sets `ALLOW_AD_HOC_MACOS_RELEASE` to `true` in
`scripts/release/signing-policy.ts`, with the date and the reason. What a macOS release signed ad
hoc costs its users, against Developer ID:

- **No notarization.** A copy that macOS quarantined (a browser download) is blocked by
  Gatekeeper.
- **No App Management protection.** `pear install` puts the app in a user-writable
  `~/Applications`, and macOS does not protect an ad-hoc app's bundle from other code running as
  the same user.
- **Privacy grants reset on every update.** An ad-hoc signature's identity is its code hash, which
  changes with every release, so camera, microphone, files and Keychain grants are asked for again.
- **Library validation is off in the processes that hold the user's key.** The app, its helpers
  and `bare` carry `disable-library-validation` while signed ad hoc, so they will load a library
  planted where they look for one.

Once a Team ID is pinned, set `ALLOW_AD_HOC_MACOS_RELEASE` back to `false` and re-sign under it.

### Build the deployment

| #   | Who  | Command                    |
| --- | ---- | -------------------------- |
| 7   | tool | `release build --out rel`  |
| 8   | tool | `release digest --out rel` |

`digest` hashes what `pear build` put in the deployment, with the update gate's own code
(`src/update/hash.ts`), and refuses if an entry differs from the digest recorded for its package.

### Publish on the Pear network

Each of these joins the public DHT. Run it as shown to see the command; add `--execute` to run it.

| #   | Who             | Command                                                                                                                                                                              |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | owner           | `pear touch`, once, for a **staging** link, and again for a **pre-production** link. Keep both.                                                                                      |
| 10  | owner           | `release stage --link <staging> --out rel`                                                                                                                                           |
| 11  | owner           | `release provision --source <staged verlink> --target <pre-production> --production <production verlink> --out rel`                                                                  |
| 12  | owner           | `release seed --link <pre-production>`, and the same on **two other machines**                                                                                                       |
| 13  | owner           | `release multisig request --config pear.json --verlink <pre-production verlink>`                                                                                                     |
| 14  | **each signer** | `release verify-request --run <run id> --commit <sha> --config pear.json --verlink <pre-production verlink> --request <request> --work <empty folder> [--signed-target <target>]...` |
| 15  | each signer     | The `pear multisig sign <request> <name>` line step 14 printed, only after it passed                                                                                                 |
| 16  | owner           | `release multisig verify --config pear.json --source <pre-production> --request <request> --response <r1> --response <r2>`                                                           |
| 17  | owner           | `pear seed <production>` on **two machines other than this one**, left running                                                                                                       |
| 18  | owner           | `release multisig commit --config pear.json --source <pre-production> --production <production> --out rel --request <request> --response <r1> --response <r2>`                       |

- **`<production verlink>` in step 11** is the production link's current version,
  `pear://<fork>.<length>.<key>`. For the very first release it is `pear://0.0.<key>`. It must be a
  version of the source's production link.
- **Steps 12 and 17 are not optional.** `pear multisig` refuses a request unless two peers hold the
  whole source, and a commit does not return until two peers hold the whole production drive. If
  nothing is seeding, it waits for ever.
- **`commit` checks the link first.** After you type the link, it asks Pear what `pear.json`
  derives, and refuses if that is not the source's production link.
- **`--out rel` records the versions.** `provision` writes the version it supersedes to
  `rel/provisioned.json`, and `commit` writes the new **production verlink** to `rel/committed.json`
  (once: a second commit from the same folder is refused). The notice names exactly that version,
  and only if it is newer than the one superseded.

#### Step 14 is what the quorum is for

**`pear multisig sign` shows you nothing about what you are approving.** It asks for your password
and prints a response. Run with Pear 3.7.0, its whole output is the password prompt, `Response signed
by ~/.pear/<name>:`, the response, and a line telling you to send it back. A compromised coordinator
could put anything in that request, so each signer checks it first, **without taking the
coordinator's word for anything but the verlink and the request**:

1. It asks GitHub for what CI built at the run and commit, and downloads those five packages. **Get
   the run id and commit from the repository, not from the coordinator.** They are what you are
   approving.
2. Every Pear step runs in a Pear home of the check's own (`<work>/pear-home`), so every answer comes
   from the same local cores. It checks that `pear.json` derives the production link, that the drive
   is at the verlink's fork, and that the request writes exactly that version onto production.
3. It fetches that version of the drive, then asks Pear (`pear provision --dry-run`) for the db and
   blobs cores it now holds, by length and tree hash. Pear 3.7.0 reports them as held, not as of
   the verlink, so both must equal what the request writes: then the cores the drive was read from
   are exactly the version signed. The blobs core is what binds the file bytes (a db entry names a
   blob, it does not hash it). A core that grew meanwhile is refused; start again in a new folder.
4. It refuses unless the drive holds exactly CI's five packages and nothing else. Name a target with
   `--signed-target` only if the owner signed it: it may then differ from CI's package by its
   signatures, as [pinned](#what-a-signature-may-say), and by nothing else.
5. It asks Pear about the request and the fork again: a core that was rewritten (forked) to the same
   length is refused here.
6. On a Mac, it runs `codesign --verify --strict --deep` on each signed macOS bundle. Anywhere else
   it prints `NOT CHECKED BY APPLE` for each one ([What a signature may say](#what-a-signature-may-say)).
   **With a Team ID pinned, that is a refusal:** it exits non-zero and prints no sign line, because
   off a Mac a forged Apple signature passes every other check. At least one signer in the quorum
   runs `verify-request` on a Mac. The others may then pass `--without-apple-check`, and get the
   sign line under a warning that says so. While no Team ID is pinned there is no CMS to check, and
   `NOT CHECKED BY APPLE` is printed and the check goes on.
7. It prints the exact `pear multisig sign` line for the request it checked, with a short hash of
   it. Compare the hash with the request you were sent, and sign that line, not a pasted one.

It joins the public DHT and downloads about a gigabyte. It refuses on CI.

#### What step 14 rests on in Pear 3.7.0

The check binds the bytes it reads to the bytes the quorum signs only if four things hold of Pear
3.7.0 and the libraries its lock pins. Each was read in that source (Pear `3.7.0`; from its
`package-lock.json`: hyper-multisig `2.4.0`, hypercore-signing-request `5.2.0`, hypercore-sign-lib
`1.1.0`, hypercore `11.38.0`, hyperdrive `13.3.4`, hyperbee `2.27.3`):

1. **One home, one store.** Every `pear` command talks to the sidecar of its home, and the sidecar
   has one corestore: `constants.js:71-78` (the platform directory, `corestores/platform-next` and
   the socket, all under it) and `constants.js:89-94` (the platform directory is under the home),
   `sidecar.js:55` (the one `Corestore`), `subsystems/sidecar/index.js:336-337` (`getCorestore()`
   is a session of it). `dump` (`ops/dump.js:37`), `info` (`ops/info.js:32`), `provision`'s source
   (`ops/provision.js:41`; its dry run's _target_ is a temporary store, `:47-48`) and
   `multisig verify` (`ops/multisig.js:90-94`) all read through it.
2. **The request binds both cores, and a mismatched source is refused.** A request carries the db's
   length and tree hash and the blobs' (hypercore-signing-request `index.js:173-192`); each signer
   signs exactly those (`index.js:238-268`; hypercore-sign-lib `index.js:82-88`). The dry run
   decodes them (hyper-multisig `index.js:425`) and refuses a source whose tree hash at that length
   differs, db and blobs alike (`index.js:430-443`, `lib/verify.js:54-56`).
3. **A fork only moves forward here.** The check's home only replicates. A replica takes data of
   another fork only as a reorganisation to a _higher_ fork (hypercore `lib/replicator.js:1219`),
   and refuses a proof of any other fork than its own (`lib/core.js:796`).
4. **What the dry run reports is the core as held.** `pear provision --dry-run` reports
   `co.core.length` and `co.core.treeHash()` of a checkout, blobs alike (`ops/provision.js:126,166-180`). A
   checkout at a version the core already has is a snapshot of the whole core (hyperbee
   `index.js:762-782`; hyperdrive `index.js:30-31` makes it the drive's `core`), and `treeHash()`
   with no length uses the snapshot's length (hypercore `index.js:1195-1201`). So it is the length
   and tree hash of the core held now, not at the verlink, which is why both must equal what the
   request writes.

CI proves the honest path and that a different version's cores are refused (from a recorded
report). It does not exercise a core that grows or forks during a check.

### The notice

Installed apps hold the new build until a notice names it, so do this right after the commit. Run
these from the root of this repository, with the submodule at a commit that has nutflix-pear's
`nutflix-runtime` support and `RUNTIME_PRODUCTION_LINK` set (step 5 of "Once"), after `npm run build`.

| #   | Who   | Command                                                                                                                                           |
| --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19  | tool  | `release notice-draft --out rel`                                                                                                                  |
| 20  | owner | `node vendor/nutflix-pear/scripts/release-publish.mjs rel/release-event.unsigned.json --dir rel/notice-files --d nutflix-runtime`                 |
| 21  | owner | Check it as a user would: `node vendor/nutflix-pear/scripts/release-verify.mjs rel/release-event.json --d nutflix-runtime --all rel/notice-files` |

Step 19 writes `rel/release-event.unsigned.json`: a kind-30071 event with no `id` and no signature.
Its commit is the one the packages carry and its version the one `commit` recorded in
`rel/committed.json`; it takes neither from the command line. It refuses a version that is not newer
than the one `provision` recorded as superseded: a stale notice would only raise every install's
replay floor. Step 20 checks every file against it, asks your NIP-46
signer to sign it, shows you what it is about to publish, and sends it only after you type
`publish`, to exactly:

```
wss://relay.nutflix.xyz   wss://relay.primal.net   wss://relay.ditto.pub
```

**Expect `relay.nutflix.xyz` to refuse it.** Its public NIP-11 document lists kinds
38504, 20464, 5 and 25050, with `restricted_writes`, and the relay software answers any other kind
`blocked: out of scope`. Nothing has been published to test this. One relay is enough for an app to
apply an update, so the notice still works through the other two, but it then rests on those two.
Until that relay carries kind 30071, or is taken out of `RELEASE_NOTICE_RELAYS`, a `FAILED` line for
it is expected. **Step 20 exits with an error unless both `relay.primal.net` and `relay.ditto.pub`
accepted the notice.** Run it again with `rel/release-event.json` to retry.

## The day the link is set

Setting `RELEASE_UPGRADE_LINK` makes every release build start an updater on the public DHT, so
the guard (`scripts/pear-ci/no-updater.ts`) refuses to launch one. It is not weakened for this day.

**What that commit trips, on purpose:** two tests in `packaging/__tests__/update-root.test.ts`. `is
inert` pins the link to `null`, and `refuses to let a runner launch a build that would start an
updater` expects the release root to pass the guard. Change both in that commit, so that they
state the new fact: the link is the reviewed value, and the guard refuses the release root. Nothing
else needs to change, and in particular **not** the check in `noticeDraft` that a notice names a
version of the expected link: the CI proofs and tests pass their own throwaway link to it.

From that commit on, the `shell` job does this on every target:

1. It builds the release package with the production root, as always.
2. It verifies that package **from its bytes**: `cli.ts verify-root` reads the root baked into the
   updater and main's updates switch, and refuses anything but what the source declares. The package
   is never started.
3. `launch-subject.ts` sees the link and makes a second build of the same source with a **throwaway
   root and no link** (`package.ts test-build`, channel `launch`).
4. `no-updater.ts` runs, unchanged, on that second build, and every launch test runs against it.
5. On a push to `main` only, the production package is uploaded as `release-<target>`, which is the
   only thing `download` takes.

The `release-proof` job already rehearses steps 3 and 4 on every run. Step 5's upload has not run,
because no source has had a link yet.

## What CI proves, and what it does not

The `release-proof` job (`scripts/release/prove.ts`) runs on Linux x64, on a private DHT on
`127.0.0.1`, with keys made for the run. A firewall rule counts packets to the public DHT bootstrap
and to the public relays, and the job fails unless the count is zero.

- Against the real GitHub API, read-only: a green push to `main` passes the provenance check, this
  run and a wrong commit are refused, and each of this run's five artifacts is fetched by id and
  held to GitHub's digest (one target's artifact in another's place is refused).
- The five real packages are unpacked, checked and assembled, pass `pear build` and `digest`, and a
  notice naming all five is read by the app's own `notice.ts`.
- A signer fetches those five from the private DHT and finds them equal to CI's. Two swapped entries
  are refused.
- Two more builds go through `pear build`, `stage`, `provision`, a signer's check of the request
  (`verify-request`'s own sequence, in the signer's Pear home: fork, request, fetch, db and blobs
  cores, request and fork again), `pear multisig` (three signers, quorum two, real `keys get` and
  `sign` on a terminal; one signature is refused) and `commit`. A swapped entry, a request for
  another version than the one checked, and the cores of another version are refused.
- The first is installed from the multisig link with `pear install`. The installed app holds the
  second with no notice, a wrong hash and a wrong signer, applies it for a notice this tool drafted,
  and restarts as the new version.
- A real build with a link trips `no-updater.ts`. The build launched instead passes it, is refused
  by `verify-root`, and starts with its sandbox on and its updater off.

The `signing-proof` job signs a real macOS bundle and a real `.msix`:

- macOS, ad hoc, as above, every Mach-O: the production policy accepts it (claims and validity), and
  the signed bundle **launches and reaches its ready line**, as the shell job launches a build (the
  no-updater guard on its bytes, the public relay names pointing at loopback). Refused: a re-sign
  with `get-task-allow` added, one without the hardened runtime, an ad-hoc signature under a policy
  that pins a Team ID (a signature naming _another_ team is refused only in the unit tests: the
  job has no identity to make one with), a changed script, changed code and an added file.
- Windows, with a certificate made for the job: the production policy refuses it (no certificate is
  pinned); a policy pinning the job's certificate with its fingerprint changed refuses it (not a
  second real certificate); and a policy pinning the job's certificate, built in the proof and
  nowhere else, accepts it, content types and catalog included.

The `release-proof` job's GitHub token goes to `gh` alone: an earlier step writes it to a file only
the runner's user can read, so it is in no environment of the proof's shell, `xvfb-run` or `node`;
the proof reads it, deletes the file before it starts anything, and checks that a child process has
no token. A launch's events are reported apart from what the app prints while the harness stops it
(SIGTERM to its process group), and a failure event before the stop fails the run.

It does **not** prove:

- anything on the public DHT or a public relay, including `--execute` on a real link and a
  `verify-request` against real peers;
- that `relay.nutflix.xyz` accepts a notice (it is expected not to);
- the multisig chain on macOS or Windows: the `install` job proves `pear install` and the update
  gate on all five targets, on a plain link;
- a deployment assembled on Linux installed on a real Mac;
- signing with a real Apple or Windows certificate, notarization or stapling, or a Team ID read from
  a real Developer ID signature (the Team ID check runs on an ad-hoc signature, and on synthetic
  signatures in the unit tests);
- that a catalog SignTool writes for a real CA certificate has the same shape as the one for the
  job's certificate;
- that a build's code matches its source: the checks read what a build declares (see above).
