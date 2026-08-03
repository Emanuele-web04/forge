#!/usr/bin/env bash
# A remote host WITH systemd, so the supervisor step is exercised for real.
# Needs --privileged and a cgroup mount: systemd inside Docker is not a
# lightweight thing, which is why the other two hosts do not use it.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
key="$here/demo_key"; name="synara-remote-systemd"; port="${SYNARA_SYSTEMD_PORT:-2224}"

[ -f "$key" ] || { echo "run ./up.sh first to generate the demo key" >&2; exit 1; }
cp "$key.pub" "$here/authorized_keys"

docker rm -f "$name" >/dev/null 2>&1 || true
docker build -q -f "$here/Dockerfile.systemd" -t synara-remote-systemd "$here" >/dev/null
docker run -d --name "$name" --privileged \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --cgroupns=host \
  -p "$port:22" --add-host host.docker.internal:host-gateway \
  synara-remote-systemd >/dev/null

for _ in $(seq 1 60); do
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
         -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 \
         -i "$key" -p "$port" synara@127.0.0.1 true 2>/dev/null; then
    echo "ready: port $port"
    ssh -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
        -i "$key" -p "$port" synara@127.0.0.1 \
        'echo "  node: $(node --version)"; echo -n "  systemd: "; systemctl --version | head -1; echo -n "  user manager: "; systemctl --user is-system-running 2>&1 | head -1'
    exit 0
  fi
  sleep 1
done
echo "container did not become reachable" >&2; docker logs "$name" 2>&1 | tail -20; exit 1
