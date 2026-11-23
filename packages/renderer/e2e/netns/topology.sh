#!/usr/bin/env bash
# The isolated network the WebRTC proofs run on, as root, on a throwaway CI runner:
#
#   nfx-a  11.77.0.2 ─┐
#   nfx-b  11.77.0.3 ─┼─ br0 in nfx-hub, 11.77.0.1 (strfry, STUN, nfxd, the test itself)
#
# Why these addresses: the player drops every remote ICE candidate that is not global unicast
# (private, loopback, link-local, mDNS and documentation blocks are all refused), and that filter
# is not to be weakened for a test. So the peers need addresses the filter calls global.
# 11.0.0.0/8 is such a block. Nothing here can reach whoever holds it:
#
#   - the three namespaces are joined only to each other: no veth end is in the runner's own
#     namespace, nothing is NATed, and forwarding stays off;
#   - each has a default route INTO the bridge, only because Chromium's
#     `default_public_interface_only` needs a default route to pick an interface;
#   - the tripwire: in each namespace the last OUTPUT rule DROPs and COUNTS anything not bound for
#     loopback or 11.77.0.0/24. `check` proves the counter counts (one canary datagram to an RFC
#     5737 address per namespace) and `counts` prints what it caught.
#
#   topology.sh up | check | counts | down
set -euo pipefail

NET=11.77.0
HUB=$NET.1
COMMENT=nutflix-netns-tripwire
SPACES=(nfx-hub nfx-a nfx-b)
CANARY=192.0.2.77

in_ns() {
    local ns=$1
    shift
    ip netns exec "$ns" "$@"
}

tripwire() {
    local ns=$1
    in_ns "$ns" iptables -w 10 -A OUTPUT -o lo -j ACCEPT
    in_ns "$ns" iptables -w 10 -A OUTPUT -d "$NET.0/24" -j ACCEPT
    in_ns "$ns" iptables -w 10 -A OUTPUT -m comment --comment "$COMMENT" -j DROP
}

count() {
    # The packet counter of the DROP rule.
    in_ns "$1" iptables -w 10 -L OUTPUT -v -n -x | awk -v c="$COMMENT" '$3 == "DROP" && index($0, c) { print $1 }'
}

case ${1:-} in
    up)
        for ns in "${SPACES[@]}"; do
            ip netns add "$ns"
            in_ns "$ns" ip link set lo up
            in_ns "$ns" sysctl -q -w net.ipv6.conf.all.disable_ipv6=1
            in_ns "$ns" sysctl -q -w net.ipv4.ip_forward=0
        done
        ip -n nfx-hub link add br0 type bridge
        ip -n nfx-hub addr add "$HUB/24" dev br0
        ip -n nfx-hub link set br0 up
        ip -n nfx-hub route add default dev br0
        n=2
        for x in a b; do
            ip link add "veth-$x" netns "nfx-$x" type veth peer name "hub-$x" netns nfx-hub
            ip -n nfx-hub link set "hub-$x" master br0
            ip -n nfx-hub link set "hub-$x" up
            ip -n "nfx-$x" addr add "$NET.$n/24" dev "veth-$x"
            ip -n "nfx-$x" link set "veth-$x" up
            ip -n "nfx-$x" route add default via "$HUB"
            n=$((n + 1))
        done
        for ns in "${SPACES[@]}"; do tripwire "$ns"; done
        ;;
    check)
        for ns in "${SPACES[@]}"; do
            echo "== $ns"
            in_ns "$ns" ip -4 -br addr
            in_ns "$ns" ip -4 route
            # Not one interface of a namespace may lead to the runner's own network.
            if in_ns "$ns" ip -o link | grep -Eq ': (eth|en|docker|azure)'; then
                echo "::error::$ns has a host interface"
                exit 1
            fi
            before=$(count "$ns")
            in_ns "$ns" bash -c "exec 3<>/dev/udp/$CANARY/9; printf canary >&3" 2>/dev/null || true
            after=$(count "$ns")
            if [ "$after" -ne $((before + 1)) ]; then
                echo "::error::the tripwire in $ns did not count its canary ($before -> $after)"
                exit 1
            fi
            echo "tripwire counts: canary seen ($before -> $after)"
        done
        for x in a b; do
            ip netns exec "nfx-$x" ping -c 1 -W 2 "$HUB" >/dev/null
        done
        ip netns exec nfx-a ping -c 1 -W 2 "$NET.3" >/dev/null
        echo "peers reach each other through the bridge"
        ;;
    counts)
        for ns in "${SPACES[@]}"; do echo "$ns $(count "$ns")"; done
        ;;
    down)
        for ns in "${SPACES[@]}"; do ip netns del "$ns" 2>/dev/null || true; done
        ;;
    *)
        sed -n '2,20p' "$0" >&2
        exit 2
        ;;
esac
