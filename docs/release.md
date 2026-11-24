# Releasing nutflix-runtime

The runbook for shape (a) of [ADR 0001](decisions/0001-a-pear-native-nutflix.md): a Pear v3 app, five
targets on one `pear://` link, updated only when a signed release notice names the build.

Every step is marked:

- **tool**: `shells/pear-v3/scripts/release/cli.ts` does it, locally. It touches no link.
- **owner**: only a person holding the release authority does it. Where the tool has a command for
  it, the tool prints the exact command by default (a dry run), and runs it only with `--execute`
  and the link typed back on a terminal. On CI, `--execute` is refused.

The tool never reads, stores or prints a signing key. Multisig keys stay in each signer's own
`~/.pear`, and the Nostr release key stays in the owner's signer.

```sh
alias release='node shells/pear-v3/scripts/release/cli.ts'   # from the repository root
```

It needs Node 22.18 or later, `unzip`, `unsquashfs` (the `squashfs-tools` package) and Linux or
macOS: a Windows file system cannot keep a macOS bundle's symlinks. Every `pear` command it runs is
the pinned CLI (3.7.0, checked against the sha256 in `scripts/pear-ci/pins.ts`), kept in
`~/.cache/nutflix-release/`. A Pear sidecar that is already running keeps serving whatever CLI talks
to it, so stop any other one first: `pear sidecar shutdown`.

## Once: the signers and the production link

| # | Who | What |
| --- | --- | --- |
| 1 | owner | Each signer, on their own machine: `pear multisig keys get <name>`. It asks for a password that cannot be recovered, and prints the public key. |
| 2 | owner | Write `pear.json` with the public keys, a quorum and a namespace (below). The link is derived from all three: changing any of them is a different link. |
| 3 | owner | `pear multisig link --config pear.json` prints the **production link**. |
| 4 | owner | Set `RELEASE_UPGRADE_LINK` to it, in a reviewed commit ([The day the link is set](#the-day-the-link-is-set)). |

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
on other people's machines (ADR 0001, amendment, item 5). **Sign them before `assemble`:** signing
changes the bytes, and the notice names the bytes. The MSIX publisher in
`packaging/identity.ts` must equal the certificate's subject, and then never change.

## Every release

### Build

| # | Who | Command |
| --- | --- | --- |
| 1 | owner | Set the version in `shells/pear-v3/package.json`, merge, and wait for CI on `main`. |
| 2 | owner | Download the packages of that run (below). |
| 3 | tool | `release check --artifacts artifacts` |
| 4 | tool | `release assemble --artifacts artifacts --out rel` |
| 5 | tool | `release build --out rel` |
| 6 | tool | `release digest --out rel` |

```sh
gh run download <run id> -R SovereignTechnology/nutflix-runtime --dir artifacts \
  --pattern 'release-linux-*' --pattern 'release-darwin-*' --pattern 'release-win32-*'
```

`check` refuses unless all five packages are there, are one version, and each carries exactly the
production root. It reads all of that from the packages' bytes and runs none of them. `assemble`
also refuses a macOS bundle that does not unpack to the exact tree the Mac runner zipped.

`digest` hashes what `pear build` put in the deployment, with the update gate's own code
(`src/update/hash.ts`), and refuses if an entry differs from the package it was made from.

### Publish on the Pear network

Each of these joins the public DHT. Run it as shown to see the command; add `--execute` to run it.

| # | Who | Command |
| --- | --- | --- |
| 7 | owner | `pear touch`, once, for a **staging** link, and again for a **pre-production** link. Keep both. |
| 8 | owner | `release stage --link <staging> --out rel` |
| 9 | owner | `release provision --source <staged verlink> --target <pre-production> --production <production verlink>` |
| 10 | owner | `release seed --link <pre-production>`, and the same on **two other machines** |
| 11 | owner | `release multisig request --config pear.json --verlink <pre-production verlink>` |
| 12 | owner | Each signer, in their own terminal: `pear multisig sign <request> <name>` |
| 13 | owner | `release multisig verify --config pear.json --source <pre-production> --request <request> --response <r1> --response <r2>` |
| 14 | owner | `pear seed <production>` on **two machines other than this one**, left running |
| 15 | owner | `release multisig commit --config pear.json --source <pre-production> --production <production> --request <request> --response <r1> --response <r2>` |

- **`<production verlink>` in step 9** is the production link's current version,
  `pear://<fork>.<length>.<key>`. For the very first release it is `pear://0.0.<key>`.
- **Steps 10 and 14 are not optional.** `pear multisig` refuses a request unless two peers hold the
  whole source, and a commit does not return until two peers hold the whole production drive. If
  nothing is seeding, it waits for ever.
- **`commit` checks the link first.** It asks Pear what `pear.json` derives, refuses if that is not
  the `--production` you gave, and only then asks you to type the link.
- `commit` prints the new **production verlink**. The notice names it.

### The notice

Installed apps hold the new build until a notice names it, so do this right after the commit.

| # | Who | Command |
| --- | --- | --- |
| 16 | tool | `release notice-draft --out rel --verlink <production verlink> --commit <full git sha>` |
| 17 | owner | In a checkout of [nutflix-pear](https://github.com/SovereignTechnology/nutflix-pear), after `npm run build`: `node scripts/release-publish.mjs rel/release-event.unsigned.json --dir rel/notice-files --d nutflix-runtime` |
| 18 | owner | Check it as a user would: `node scripts/release-verify.mjs rel/release-event.json --d nutflix-runtime --all rel/notice-files` |

Step 16 writes `rel/release-event.unsigned.json`: a kind-30071 event with no `id` and no signature.
Step 17 checks every file against it, asks your NIP-46 signer to sign it, shows you what it is about
to publish, and sends it only after you type `publish`, to exactly:

```
wss://relay.nutflix.xyz   wss://relay.primal.net   wss://relay.ditto.pub
```

**Expect `relay.nutflix.xyz` to refuse it.** Its public NIP-11 document lists kinds
38504, 20464, 5 and 25050, with `restricted_writes`, and the relay software answers any other kind
`blocked: out of scope`. Nothing has been published to test this. One relay is enough for an app to
apply an update, so the notice still works through the other two, but it then rests on those two.
Until that relay carries kind 30071, or is taken out of `RELEASE_NOTICE_RELAYS`, a `FAILED` line for
it is expected, and a failure on **either of the others** is not.

## The day the link is set

Setting `RELEASE_UPGRADE_LINK` makes every release build start an updater on the public DHT. **A
GitHub runner must never launch one**, so the guard (`scripts/pear-ci/no-updater.ts`) refuses to.
It is not weakened for this day, and the commit that sets the link also has to change the test that
pins the link to `null` (`is inert`), on purpose.

From that commit on, the `shell` job does this on every target:

1. It builds the release package with the production root, as always.
2. It verifies that package **from its bytes**: `cli.ts verify-root` reads the root baked into the
   updater and refuses anything but exactly what the source declares. The package is never started.
3. `launch-subject.ts` sees the link and makes a second build of the same source with a **throwaway
   root and no link** (`package.ts test-build`, channel `launch`).
4. `no-updater.ts` runs, unchanged, on that second build, and every launch test runs against it.
5. The production package is uploaded as `release-<target>`, which is what `check` takes.

The `release-proof` job already rehearses steps 3 and 4 on every run. Step 5's upload and the
production packages have not run, because no source has had a link yet.

## What CI proves, and what it does not

The `release-proof` job (`scripts/release/prove.ts`) runs on Linux x64, on a private DHT on
`127.0.0.1`, with keys made for the run. A firewall rule counts packets to the public DHT bootstrap
and to the public relays, and the job fails unless the count is zero.

- The five real packages pass `check`, `assemble`, `pear build` and `digest`, and a notice naming
  all five is read by the app's own `notice.ts`.
- Two more builds go through `pear build`, `stage`, `provision`, `pear multisig` (three signers,
  quorum two, real `keys get` and `sign` on a terminal; one signature is refused) and `commit`.
- The first is installed from the multisig link with `pear install`. The installed app holds the
  second with no notice, a wrong hash and a wrong signer, applies it for a notice this tool drafted,
  and restarts as the new version.
- A real build with a link trips `no-updater.ts`. The build launched instead passes it, is refused
  by `verify-root`, and starts with its sandbox on and its updater off.

It does **not** prove:

- anything on the public DHT or a public relay;
- that `relay.nutflix.xyz` accepts a notice (it is expected not to);
- the multisig chain on macOS or Windows: the `install` job proves `pear install` and the update
  gate on all five targets, on a plain link;
- a build signed by a real Apple or Windows certificate.
