#!/usr/bin/env bash
# The real `pear run` proof of shells/pear-v2. Runs ONLY in a throwaway VM with network access
# (`kata-run --net`), never on a developer machine and never on GitHub: it fetches Pear v2.6.5 from
# the public DHT as a client, because that platform has no other download.
#
#   kata-run --cwd <repo> --net --no-setup --timeout 2400 -- bash shells/pear-v2/proof/run.sh
#
# Everything after the fetch runs on a private DHT on 127.0.0.1: the platform is copied to a key
# made in this VM, installed from it, and the app is staged and run on that network.
set -euo pipefail
REPO=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$REPO"
export DEBIAN_FRONTEND=noninteractive NUTFLIX_V2_PROOF=1
apt-get update -qq >/dev/null
apt-get install -y -qq --no-install-recommends ffmpeg xvfb xauth libatomic1 libnss3 libgbm1 \
  libxss1 libxtst6 libdrm2 libxkbcommon0 libatk-bridge2.0-0 libxshmfence1 libgtk-3-0 \
  libasound2 libcups2 >/dev/null
[ -e vendor/nutflix-pear/package.json ] || git submodule update --init --depth 1
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
npm ci --ignore-scripts --no-audit --no-fund --prefix shells/pear-v2/app >/dev/null
npm ci --ignore-scripts --no-audit --no-fund --prefix spikes/s1-pear-v2 >/dev/null
node_modules/.bin/tsc -b
cd shells/pear-v2
exec ../../node_modules/.bin/vitest run --config vitest.proof.config.ts --reporter=verbose
