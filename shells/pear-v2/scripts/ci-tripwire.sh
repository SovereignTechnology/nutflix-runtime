#!/usr/bin/env bash
# GitHub runners are never peers of the public network. Around anything that loads the DHT code,
# this drops and COUNTS packets to HyperDHT's three public bootstrap addresses, and proves the
# counter works with one datagram to a documentation address (RFC 5737, never routed).
#
#   ci-tripwire.sh arm      install the rules and count the canary
#   ci-tripwire.sh check    fail unless the public bootstrap count is zero
set -euo pipefail
PUBLIC=(88.99.3.86 142.93.90.113 138.68.147.8)
CANARY=203.0.113.7

count() { sudo iptables -L OUTPUT -v -n -x | awk -v ip="$1" '$3 == "DROP" && $9 == ip { n += $1 } END { print n + 0 }'; }

case "${1:-}" in
  arm)
    for ip in "${PUBLIC[@]}" "$CANARY"; do sudo iptables -I OUTPUT -d "$ip" -j DROP; done
    node -e "const s=require('dgram').createSocket('udp4');s.send(Buffer.from('x'),9,'$CANARY',()=>s.close())"
    sleep 1
    [ "$(count "$CANARY")" -ge 1 ] || { echo 'the tripwire did not count its canary'; exit 1; }
    echo "tripwire armed: canary counted"
    ;;
  check)
    total=0
    for ip in "${PUBLIC[@]}"; do total=$((total + $(count "$ip"))); done
    echo "packets to the public DHT bootstrap: $total"
    [ "$total" -eq 0 ]
    ;;
  *) echo 'usage: ci-tripwire.sh arm|check'; exit 2 ;;
esac
