# nutflix-runtime

A Pear-native Nutflix: a peer-to-peer video app that lives on the Pear network. It is installed
from a `pear://` link and updates itself from that same link. There is no download server.

**Status: pre-alpha.** Nothing here runs yet. The design is in
[ADR 0001](docs/decisions/0001-a-pear-native-nutflix.md), and the spikes that gate it are in
[`docs/spikes/`](docs/spikes/).

## What it is for

- **Watch free NFX videos** seeded by [nutflix-pear](https://github.com/SovereignTechnology/nutflix-pear)
  desktop apps, over HyperDHT (NFX-12) natively in the app's Bare worker.
- **Trade video with web browsers and nfxd** over WebRTC, signaled over Nostr (NFX-10 §6). This
  runs in the app's Chromium window, and is the same player as the web client.
- **Fall back to HyperDHT alone** where the runtime has no WebRTC, WebAssembly or Media Source
  Extensions.
- **Seed what it plays, and publish** new videos from the app.

Paid videos (Cashu, `pay/1`) are not in scope for the first version.

## How it ships

- **Pear v3:** `pear install pear://<key>`. Updates come over the Pear network from the same link.
  Each release needs a `pear multisig` quorum, and the app applies an update only when a
  SovTech-signed Nostr release notice names it. Pear 3.7.0 stops with `ENOENT` if the folder it
  installs into is missing, so make it first:

  ```sh
  mkdir -p ~/Applications                              # macOS
  mkdir -p ~/.local/bin ~/.local/share/applications    # Linux
  ```
- **Pre-v3 Pear (`pear run pear://…`):** unsandboxed legacy software, not released, under the
  conditions in [ADR 0001's amendment](docs/decisions/0001-a-pear-native-nutflix.md#amendment-2026-11-22).
  Holepunch removed `pear run` in Pear v3. **Prefer `pear install`.** See
  [`shells/pear-v2`](shells/pear-v2/README.md).

## Relationship to nutflix-pear

This repository reuses nutflix-pear's packages (`@sovit/core`, `@sovit/ui`, `@sovit/seeder`)
through a pinned git submodule rather than copying them, so the wire formats stay byte-compatible
with deployed seeders.

## Layout

- `vendor/nutflix-pear`: nutflix-pear, a git submodule pinned to one commit. Its `core` and
  `seeder` packages are npm workspaces here, built from source.
- `packages/worker`: the Bare worker, the data plane. Its protocol is in
  [its README](packages/worker/README.md).
- `packages/renderer`: the Chromium renderer, nutflix-pear's UI over a worker pipe. See
  [its README](packages/renderer/README.md).
- `shells/pear-v3`: the Pear v3 desktop shell: a hardened Electron main, the worker started through
  `pear-runtime`, packaged on five targets (updates off). See
  [its README](shells/pear-v3/README.md).
- `shells/pear-v2`: the pinned `pear run` shell, unsandboxed legacy software on Pear v2.6.5 with its
  own dependency pins. See [its README](shells/pear-v2/README.md).

Clone with `git clone --recurse-submodules`, or run `git submodule update --init` after a plain
clone. `npm ci`, `npm run build`, `npm run lint` and `npm test` work as in nutflix-pear. The tests
run in CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Licence

AGPL-3.0-or-later. See [LICENSE](LICENSE).
