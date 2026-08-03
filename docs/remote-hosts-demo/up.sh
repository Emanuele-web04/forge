#!/usr/bin/env bash
# Brings up a container that stands in for a remote host: real sshd, real Node,
# and no provider credentials. Reachable at synara@127.0.0.1:2222.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
key="$here/demo_key"
name="synara-remote-demo"
port="${SYNARA_DEMO_PORT:-2222}"

# A dedicated keypair: nothing here should depend on the operator's own keys,
# and a reviewer reproducing this must not be asked to authorize one.
if [ ! -f "$key" ]; then
  ssh-keygen -t ed25519 -f "$key" -N "" -C "synara-demo" >/dev/null
  echo "generated $key"
fi
cp "$key.pub" "$here/authorized_keys"

docker rm -f "$name" >/dev/null 2>&1 || true
docker build -q -t synara-remote-demo "$here" >/dev/null
docker run -d --name "$name" -p "$port:22" \
  --add-host host.docker.internal:host-gateway \
  synara-remote-demo >/dev/null

# sshd needs a moment; poll rather than sleep so a slow machine still works.
for _ in $(seq 1 30); do
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
         -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 \
         -i "$key" -p "$port" synara@127.0.0.1 true 2>/dev/null; then
    echo "ready: ssh -i $key -p $port synara@127.0.0.1"
    ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
        -o UserKnownHostsFile=/dev/null -i "$key" -p "$port" synara@127.0.0.1 \
        'echo "  node: $(node --version)"; echo "  home: $HOME"; [ -d ~/.claude ] && echo "  claude: present" || echo "  claude: ABSENT (this is the point)"'
    exit 0
  fi
  sleep 1
done

echo "container did not become reachable" >&2
docker logs "$name" >&2 || true
exit 1
