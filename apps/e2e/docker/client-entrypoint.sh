#!/bin/sh
# Egress pinhole for the isolated client. This container may open connections
# to exactly two destinations: the account API and the relay, both published
# on the developer machine's LAN IP. Everything else is rejected at the packet
# filter — the host's own port on that SAME IP, host.docker.internal, other
# containers, the internet — so the relay is provably the only route to the
# host. Rules need root; the client itself then runs as the unprivileged user.
set -eu
: "${SYNARA_E2E_ALLOW_IP:?LAN IP the API and relay are published on}"
: "${SYNARA_E2E_ALLOW_PORTS:?comma-separated TCP ports allowed on that IP}"

iptables -F OUTPUT
iptables -A OUTPUT -o lo -j ACCEPT
# Docker's embedded resolver, so names in the forbidden-URL list resolve (and
# their connections then fail on the rule below, not on DNS).
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
for port in $(printf '%s' "$SYNARA_E2E_ALLOW_PORTS" | tr ',' ' '); do
  iptables -A OUTPUT -d "$SYNARA_E2E_ALLOW_IP" -p tcp --dport "$port" -j ACCEPT
done
iptables -A OUTPUT -j REJECT --reject-with icmp-port-unreachable
echo "[pinhole] egress rules:" >&2
iptables -S OUTPUT | sed 's/^/[pinhole]   /' >&2

cd /app
exec setpriv --reuid=bun --regid=bun --init-groups bun run apps/e2e/docker/client.ts
