#!/usr/bin/env bash
# `npm audit signatures`, tried again only when npm's attestations endpoint answered with no JSON.
#
# On 2026-11-24 the `verify` job failed four times, each time on a re-run-able glitch: the registry
# answered a package's attestations URL with a bare "OK", and npm stopped with
#
#   npm error code FETCH_ERROR
#   npm error errno FETCH_ERROR
#   npm error invalid json response body at https://registry.npmjs.org/-/npm/v1/attestations/<pkg>@<ver> reason: ...
#
# before it had verified anything. That, and only that, is tried again: at most MAX_ATTEMPTS runs in
# all, BACKOFF_S apart (30, 60 and 120 s, about three and a half minutes in all), because the glitch
# can last minutes: on PR #27 three attempts within 20 s all met it. Each attempt is a whole new
# `npm audit signatures`, which must pass on its own. Anything else fails at once with npm's own
# exit status, above all a missing or invalid registry signature or attestation: an attempt is
# retried only when every line it printed is an `npm error` line, its one error code is
# FETCH_ERROR, one line is that attestations URL on registry.npmjs.org, and no line says
# "signature", "tamper", EINTEGRITY or EATTESTATION in any case. The rule is an allow-list: output
# it does not know is a failure.
#
# `npm` and `sleep` are found on PATH: .github/scripts/npm-audit-signatures.test.sh puts fakes there.
set -uo pipefail

readonly MAX_ATTEMPTS=4
readonly BACKOFF_S=(30 60 120)
readonly GLITCH_URL='^npm error invalid json response body at https://registry\.npmjs\.org/-/npm/v1/attestations/[^[:space:]]+ reason: '

# Exit 0 when the output in file $1 is the attestations glitch and nothing else.
attestations_glitch() {
  local line lower codes=0 fetch=0 url=0
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    [[ -z $line ]] && continue
    lower=${line,,}
    # A verdict on a signature or an attestation, in any words npm uses for one: never again.
    [[ $lower == *signature* || $lower == *tamper* || $lower == *eintegrity* || $lower == *eattestation* ]] && return 1
    # Anything npm did not print as its error (a report, a warning): not the glitch.
    [[ $line == 'npm error '* ]] || return 1
    if [[ $line == 'npm error code '* ]]; then
      codes=$((codes + 1))
      [[ $line == 'npm error code FETCH_ERROR' ]] && fetch=1
    fi
    [[ $line =~ $GLITCH_URL ]] && url=1
  done <"$1"
  ((codes == 1 && fetch == 1 && url == 1))
}

out=$(mktemp) || exit 1
trap 'rm -f "$out"' EXIT

attempt=1
while :; do
  status=0
  npm audit signatures >"$out" 2>&1 || status=$?
  cat "$out"
  ((status == 0)) && exit 0
  if ! attestations_glitch "$out"; then
    exit "$status"
  fi
  if ((attempt >= MAX_ATTEMPTS)); then
    echo "npm audit signatures: the registry's attestations endpoint answered with no JSON on all ${MAX_ATTEMPTS} attempts; giving up." >&2
    exit "$status"
  fi
  wait_s=${BACKOFF_S[attempt - 1]}
  echo "::warning title=npm audit signatures::the registry's attestations endpoint answered with no JSON (attempt ${attempt} of ${MAX_ATTEMPTS}); trying again in ${wait_s} s. Nothing was verified by this attempt."
  sleep "$wait_s"
  attempt=$((attempt + 1))
done
