#!/usr/bin/env bash
# The retry rule of npm-audit-signatures.sh, against a fake `npm` that prints what the test hands it
# and a fake `sleep` that only records: the attestations glitch is tried again, at most three
# attempts in all; nothing else ever is, above all a missing or invalid signature or attestation.
#
#   bash .github/scripts/npm-audit-signatures.test.sh
set -uo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
script="$here/npm-audit-signatures.sh"
work=$(mktemp -d) || exit 1
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin"

# The fake npm: the Nth call prints $FAKE/out.N and exits with $FAKE/rc.N; a call with no plan fails.
cat >"$work/bin/npm" <<'EOF'
#!/usr/bin/env bash
n=$(($(cat "$FAKE/n") + 1))
echo "$n" >"$FAKE/n"
printf '%s\n' "$*" >>"$FAKE/args"
[[ -f $FAKE/rc.$n ]] || { echo "fake npm: no plan for call $n" >&2; exit 97; }
cat "$FAKE/out.$n"
exit "$(cat "$FAKE/rc.$n")"
EOF
cat >"$work/bin/sleep" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >>"$FAKE/sleeps"
EOF
chmod +x "$work/bin/npm" "$work/bin/sleep"

# ---- what npm prints ------------------------------------------------------------------------------

# Verbatim from the `verify` job of 2026-11-24 (the registry's body was "OK" and a newline).
glitch() {
  cat <<EOF
npm error code FETCH_ERROR
npm error errno FETCH_ERROR
npm error invalid json response body at https://registry.npmjs.org/-/npm/v1/attestations/${1:-undici-types@7.24.6} reason: Unexpected token 'O', "OK
npm error " is not valid JSON
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-11-24T09_42_00_171Z-debug-0.log
EOF
}

passed() {
  cat <<'EOF'
audited 1267 packages in 3s

1267 packages have verified registry signatures

98 packages have verified attestations
EOF
}

invalid_signature() {
  cat <<'EOF'
audited 1267 packages in 3s

1266 packages have verified registry signatures

1 package has an invalid registry signature:

undici-types@7.24.6 (https://registry.npmjs.org/)

Someone might have tampered with this package since it was published on the registry!
EOF
}

missing_signature() {
  cat <<'EOF'
audited 1267 packages in 3s

1266 packages have verified registry signatures

1 package has a missing registry signature but the registry is providing signing keys:

typescript-eslint@8.72.2 (https://registry.npmjs.org/)
EOF
}

invalid_attestation() {
  cat <<'EOF'
audited 1267 packages in 3s

1267 packages have verified registry signatures

97 packages have verified attestations

1 package has an invalid attestation:

typescript-eslint@8.72.2 (https://registry.npmjs.org/)

Someone might have tampered with this package since it was published on the registry!
EOF
}

# ---- the harness ----------------------------------------------------------------------------------

failures=0
case_dir=''

# plan RC1 OUT1 RC2 OUT2 ...: what each call of npm prints and how it exits.
plan() {
  case_dir=$(mktemp -d "$work/case.XXXXXX")
  echo 0 >"$case_dir/n"
  : >"$case_dir/sleeps"
  : >"$case_dir/args"
  local i=1
  while (($# >= 2)); do
    echo "$1" >"$case_dir/rc.$i"
    printf '%s\n' "$2" >"$case_dir/out.$i"
    shift 2
    i=$((i + 1))
  done
}

# expect NAME STATUS CALLS SLEEPS: run the script on the plan, and check what it did.
expect() {
  local name=$1 want_status=$2 want_calls=$3 want_sleeps=$4 status=0 calls sleeps args
  FAKE=$case_dir PATH="$work/bin:$PATH" bash "$script" >"$case_dir/stdout" 2>"$case_dir/stderr" || status=$?
  calls=$(cat "$case_dir/n")
  sleeps=$(tr '\n' ' ' <"$case_dir/sleeps")
  sleeps=${sleeps% }
  args=$(sort -u "$case_dir/args")
  if [[ $status != "$want_status" || $calls != "$want_calls" || $sleeps != "$want_sleeps" ]]; then
    echo "FAIL  $name: exit $status, $calls calls, sleeps [$sleeps]; wanted exit $want_status, $want_calls calls, sleeps [$want_sleeps]"
    sed 's/^/      | /' "$case_dir/stdout" "$case_dir/stderr"
    failures=$((failures + 1))
    return
  fi
  if [[ $calls != 0 && $args != 'audit signatures' ]]; then
    echo "FAIL  $name: npm was called with [$args], not [audit signatures]"
    failures=$((failures + 1))
    return
  fi
  echo "ok    $name"
}

# Each attempt's output reaches the log.
expect_in_log() {
  local name=$1 text=$2
  if grep -qF -- "$text" "$case_dir/stdout"; then
    echo "ok    $name"
  else
    echo "FAIL  $name: the log does not show [$text]"
    failures=$((failures + 1))
  fi
}

# ---- the cases ------------------------------------------------------------------------------------

plan 0 "$(passed)"
expect 'a clean pass runs once' 0 1 ''

plan 1 "$(glitch)" 0 "$(passed)"
expect 'the glitch, then a pass: tried again once, after 5 s' 0 2 '5'
expect_in_log 'the glitch is in the log' 'attestations/undici-types@7.24.6'
expect_in_log 'the pass is in the log' 'have verified registry signatures'
expect_in_log 'the retry is a warning' '::warning title=npm audit signatures::'

plan 1 "$(glitch)" 1 "$(glitch typescript-eslint@8.72.2)" 0 "$(passed)"
expect 'the glitch twice, then a pass: three attempts' 0 3 '5 15'

plan 1 "$(glitch)" 1 "$(glitch)" 1 "$(glitch)" 0 "$(passed)"
expect 'the glitch three times: gives up after three, with npm'"'"'s status' 1 3 '5 15'

plan 1 "$(invalid_signature)"
expect 'an invalid registry signature fails at once' 1 1 ''

plan 1 "$(missing_signature)"
expect 'a missing registry signature fails at once' 1 1 ''

plan 1 "$(invalid_attestation)"
expect 'an invalid attestation fails at once' 1 1 ''

plan 1 "$(glitch)" 1 "$(invalid_signature)" 0 "$(passed)"
expect 'the glitch, then an invalid signature: fails at the second, no third' 1 2 '5'

plan 1 "$(glitch)" 1 "$(invalid_attestation)" 0 "$(passed)"
expect 'the glitch, then an invalid attestation: fails at the second, no third' 1 2 '5'

plan 1 "$(glitch)
$(invalid_signature)"
expect 'the glitch printed with a signature verdict: fails at once' 1 1 ''

plan 1 "$(glitch)
npm error code EINTEGRITYSIGNATURE"
expect 'a second error code beside FETCH_ERROR: fails at once' 1 1 ''

plan 1 "$(glitch | sed 's/code FETCH_ERROR/code E500/')"
expect 'another error code on the attestations URL: fails at once' 1 1 ''

plan 1 "$(glitch | sed 's#registry.npmjs.org/-/npm/v1/attestations/#registry.npmjs.org/-/npm/v1/keys/#')"
expect 'FETCH_ERROR on another registry URL: fails at once' 1 1 ''

plan 1 "$(glitch | sed 's#https://registry.npmjs.org/#https://registry.npmjs.org.example/#')"
expect 'FETCH_ERROR on another host: fails at once' 1 1 ''

plan 1 "$(glitch | sed 's#https://registry#http://registry#')"
expect 'FETCH_ERROR over plain http: fails at once' 1 1 ''

plan 1 "$(glitch | sed '/invalid json response body/d')"
expect 'FETCH_ERROR with no attestations line: fails at once' 1 1 ''

plan 1 "$(printf 'npm warn config something\n%s' "$(glitch)")"
expect 'a line npm did not print as its error: fails at once' 1 1 ''

plan 1 "$(glitch | sed 's/reason: .*/reason: invalid signature, "OK/')"
expect 'the word signature anywhere: fails at once' 1 1 ''

plan 1 'npm error code ECONNRESET
npm error network aborted'
expect 'a network error: fails at once (not this glitch)' 1 1 ''

plan 1 ''
expect 'a failure with no output: fails at once' 1 1 ''

plan 2 "$(glitch)" 0 "$(passed)"
expect 'the glitch with another exit status, then a pass' 0 2 '5'

plan 1 "$(invalid_signature)" 0 "$(passed)"
expect 'a signature failure is never re-run to green' 1 1 ''

plan 1 "$(glitch | sed 's/$/\r/')" 0 "$(passed)"
expect 'the glitch with CRLF line ends: tried again' 0 2 '5'

if ((failures > 0)); then
  echo "$failures case(s) failed"
  exit 1
fi
echo 'all cases passed'
