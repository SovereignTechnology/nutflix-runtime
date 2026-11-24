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

It needs Node 22.18 or later, the [`gh` CLI](https://cli.github.com/) signed in (it reads the GitHub
API and downloads artifacts, and the tool never sees its token), `unzip`, `unsquashfs` (the
`squashfs-tools` package) and Linux or macOS: a Windows file system cannot keep a macOS bundle's
symlinks. Every `pear` command it runs is the pinned CLI (3.7.0, checked against the sha256 in
`scripts/pear-ci/pins.ts`), kept in `~/.cache/nutflix-release/`. A Pear sidecar that is already
running keeps serving whatever CLI talks to it, so stop any other one first: `pear sidecar shutdown`.

## What the checks are, and what they are not

- **What ties a release to reviewed code is where it came from.** `check` asks GitHub that the run is
  this repository's `ci.yml`, a push to `main`, at the commit you name, and successful, and holds
  each artifact to the digest GitHub reports for that run. If GitHub cannot be reached it refuses;
  there is no offline path.
- **Everything else is a check against a mistake, not against hostile code.** `verify-root`, the
  baked commit, main's updates switch and the CPU check read what a build declares. Hostile code can
  declare the right values and do something else. `--execute`, the typed-back link and the refusal
  on CI stop a slip: anything already running on your machine can unset `CI` or fake a terminal.
- **The rule for runners:** nothing on a runner can reach the public DHT, and a build carrying the
  production link is never launched there. A `test` build with a throwaway link is launched: its
  DHT is forced to `127.0.0.1` by the trust-root parser, and a firewall rule counts packets to the
  public addresses and fails the job on any.

## Once: the signers and the production link

| # | Who | What |
| --- | --- | --- |
| 1 | each signer | `pear multisig keys get <name>`. It asks for a password that cannot be recovered, and prints the public key. |
| 2 | owner | Write `pear.json` with the public keys, a quorum and a namespace (below). The link is derived from all three: changing any of them is a different link. Give every signer the same file. |
| 3 | owner | `pear multisig link --config pear.json` prints the **production link**. |
| 4 | owner | Set `RELEASE_UPGRADE_LINK` to it, in a reviewed commit ([The day the link is set](#the-day-the-link-is-set)). |
| 5 | owner | In nutflix-pear, set `RUNTIME_PRODUCTION_LINK` to the same link, in a reviewed commit, and move this repository's `vendor/nutflix-pear` submodule to a commit that has it. Until then its publish script refuses this app's notices. |

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

| # | Who | Command |
| --- | --- | --- |
| 1 | owner | Set the version in `shells/pear-v3/package.json`, merge, and wait for CI on `main`. Note the run id and the full commit. |
| 2 | tool | `release download --run <run id> --commit <sha> --artifacts artifacts` |
| 3 | tool | `release check --run <run id> --commit <sha> --artifacts artifacts` |
| 4 | tool | `release assemble --run <run id> --commit <sha> --artifacts artifacts --out rel` |

`release-<target>` artifacts exist only for a push to `main` of a source with a production link. A
pull request's build never produces one, and `check` refuses any other run.

`check` refuses unless all five packages are there, are the artifacts GitHub holds for that run, are
one version, carry the commit you named, hold exactly the production root, and are built for their
CPU. It unpacks each one and reads the result, and runs none of them. A zip with a duplicate or
ambiguous entry is refused, and a macOS bundle must unpack to the exact tree the Mac runner zipped.
`assemble` records each package's digest in `rel/release.json`, and later steps compare against that
record rather than trusting the files in `rel/`.

### Sign (macOS and Windows)

| # | Who | Command |
| --- | --- | --- |
| 5 | owner | Copy each macOS bundle and the `.msix` out of `rel/apps/<target>/`, and sign, notarize and staple **the copy**. |
| 6 | tool | `release record-signed --out rel --target <target> --signed <path to the signed Nutflix.app or Nutflix.msix>` |

`record-signed` checks that CI's package is still what `check` read, then that the signed one is
that package **with signatures added and nothing else changed**: every file, symlink and executable
bit equal, Mach-O code equal once the signature is taken out, every part of an `.msix` equal except
its signature. It reads the root, version, commit and CPU again from the signed tree, and records
both digests. CI's digest stays the reference and is never regenerated from a signed bundle.

**Real certificates are unproven.** CI runs this step with an ad-hoc signature on macOS and a
certificate made for the job on Windows. Apple's Developer ID signing, notarization, stapling and a
certificate authority's certificate have never been through it. If a real tool changes something
else, `record-signed` refuses and names the file: that is the point to stop and look.

Without this step a target ships as CI built it: for macOS and Windows, a test build that other
people's machines will refuse.

### Build the deployment

| # | Who | Command |
| --- | --- | --- |
| 7 | tool | `release build --out rel` |
| 8 | tool | `release digest --out rel` |

`digest` hashes what `pear build` put in the deployment, with the update gate's own code
(`src/update/hash.ts`), and refuses if an entry differs from the digest recorded for its package.

### Publish on the Pear network

Each of these joins the public DHT. Run it as shown to see the command; add `--execute` to run it.

| # | Who | Command |
| --- | --- | --- |
| 9 | owner | `pear touch`, once, for a **staging** link, and again for a **pre-production** link. Keep both. |
| 10 | owner | `release stage --link <staging> --out rel` |
| 11 | owner | `release provision --source <staged verlink> --target <pre-production> --production <production verlink>` |
| 12 | owner | `release seed --link <pre-production>`, and the same on **two other machines** |
| 13 | owner | `release multisig request --config pear.json --verlink <pre-production verlink>` |
| 14 | **each signer** | `release verify-request --run <run id> --commit <sha> --config pear.json --verlink <pre-production verlink> --request <request> --work <empty folder> [--signed-target <target>]...` |
| 15 | each signer | `pear multisig sign <request> <name>`, only after step 14 passed |
| 16 | owner | `release multisig verify --config pear.json --source <pre-production> --request <request> --response <r1> --response <r2>` |
| 17 | owner | `pear seed <production>` on **two machines other than this one**, left running |
| 18 | owner | `release multisig commit --config pear.json --source <pre-production> --production <production> --request <request> --response <r1> --response <r2>` |

- **`<production verlink>` in step 11** is the production link's current version,
  `pear://<fork>.<length>.<key>`. For the very first release it is `pear://0.0.<key>`. It must be a
  version of the source's production link.
- **Steps 12 and 17 are not optional.** `pear multisig` refuses a request unless two peers hold the
  whole source, and a commit does not return until two peers hold the whole production drive. If
  nothing is seeding, it waits for ever.
- **`commit` checks the link first.** After you type the link, it asks Pear what `pear.json`
  derives, and refuses if that is not the source's production link.
- `commit` prints the new **production verlink**. The notice names it.

#### Step 14 is what the quorum is for

**`pear multisig sign` shows you nothing about what you are approving.** It asks for your password
and prints a response. Run with Pear 3.7.0, its whole output is the password prompt, `Response signed
by ~/.pear/<name>:`, the response, and a line telling you to send it back. A compromised coordinator
could put anything in that request, so each signer checks it first, **without taking the
coordinator's word for anything but the verlink and the request**:

1. It asks GitHub for what CI built at the run and commit, and downloads those five packages. **Get
   the run id and commit from the repository, not from the coordinator.** They are what you are
   approving.
2. It asks Pear whether the request is for that drive at that exact length, onto the production link
   your `pear.json` derives.
3. It fetches that version of the drive from peers, and refuses unless it holds exactly CI's five
   packages and nothing else. Name a target with `--signed-target` only if the owner signed it: it
   may then differ from CI's package by its signatures, and by nothing else.
4. It asks Pear about the request again, so that the drive cannot have changed underneath the check.

It joins the public DHT and downloads about a gigabyte. It refuses on CI.

### The notice

Installed apps hold the new build until a notice names it, so do this right after the commit. Run
these from the root of this repository, with the submodule at a commit that has nutflix-pear's
`nutflix-runtime` support and `RUNTIME_PRODUCTION_LINK` set (step 5 of "Once"), after `npm run build`.

| # | Who | Command |
| --- | --- | --- |
| 19 | tool | `release notice-draft --out rel --verlink <production verlink>` |
| 20 | owner | `node vendor/nutflix-pear/scripts/release-publish.mjs rel/release-event.unsigned.json --dir rel/notice-files --d nutflix-runtime` |
| 21 | owner | Check it as a user would: `node vendor/nutflix-pear/scripts/release-verify.mjs rel/release-event.json --d nutflix-runtime --all rel/notice-files` |

Step 19 writes `rel/release-event.unsigned.json`: a kind-30071 event with no `id` and no signature.
Its commit is the one the packages carry, and it takes none from the command line. It must name a
non-empty version of the production link. Step 20 checks every file against it, asks your NIP-46
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
- Two more builds go through `pear build`, `stage`, `provision`, a signer's check of the request,
  `pear multisig` (three signers, quorum two, real `keys get` and `sign` on a terminal; one signature
  is refused) and `commit`. A swapped entry, and a request for another version than the one checked,
  are refused.
- The first is installed from the multisig link with `pear install`. The installed app holds the
  second with no notice, a wrong hash and a wrong signer, applies it for a notice this tool drafted,
  and restarts as the new version.
- A real build with a link trips `no-updater.ts`. The build launched instead passes it, is refused
  by `verify-root`, and starts with its sandbox on and its updater off.

The `signing-proof` job signs a real macOS bundle (ad-hoc) and a real `.msix` (a certificate made for
the job), and `record-signed` accepts them. On macOS, a changed script, changed code and an added file
are each refused.

It does **not** prove:

- anything on the public DHT or a public relay, including `--execute` on a real link and a
  `verify-request` against real peers;
- that `relay.nutflix.xyz` accepts a notice (it is expected not to);
- the multisig chain on macOS or Windows: the `install` job proves `pear install` and the update
  gate on all five targets, on a plain link;
- a deployment assembled on Linux installed on a real Mac;
- signing with a real Apple or Windows certificate, notarization or stapling;
- that a build's code matches its source: the checks read what a build declares (see above).
