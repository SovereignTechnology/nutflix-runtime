# Spikes

Each spike answers one question that [ADR 0001](../decisions/0001-a-pear-native-nutflix.md)
depends on, and records PASS or FAIL in its own file. Spikes run in throwaway VMs or CI, never on
a developer's machine.

| Spike | Question | Gates |
|---|---|---|
| S1 | Can a pre-v3 Pear platform still be bootstrapped from a versioned link and kept from updating itself to v3? Does `pear run` then start a `pear-electron` GUI with a Bare worker, and what does its Chromium offer (`RTCPeerConnection`, WebAssembly, MSE, `<video>` on a loopback URL)? | Shape (b) |
| S2 | With Pear v3, from Holepunch's current Electron template: what do `pear build`, `stage` and `install` produce on a throwaway link, what does the updater's `updated` event expose, and can the new build's versioned link and file hashes be read before `applyUpdate()`? Does an installed AppImage keep Chromium's sandbox on Debian? | The update gate, shape (a) |
| S3 | Can nfx's web player use the worker's `http://127.0.0.1:<port>` origin beside a WebRTC mesh, and filter remote SDP candidates? | Decisions 4 and 5 |

## S3, read from the source (nfx `80f3ed8`)

- **Loopback origin: yes, as is.** An origin the page itself passes to `open()` goes through
  `pageOrigin()` (`web/player/src/endpoints.ts`), which accepts `http:` as well as `https:`. Only
  beacon-named origins must be `https:`. So the worker's loopback origin needs no library change.
  The worker step's end-to-end test still proves it.
- **Remote candidate filter: not there yet.** `signal-nostr.ts` puts the remote SDP straight into
  the peer connection, and no option filters its candidates. nutflix-pear ADR 0023 rule 5 needs
  one, so a small nfx PR adds it. Browsers benefit too: an offer can otherwise point any viewer's
  ICE checks at its own LAN.
