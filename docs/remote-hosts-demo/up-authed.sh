#!/usr/bin/env bash
# Second stand-in host, identical to up.sh except it can reach a provider.
#
# Nothing is copied into the container: credentials stay on the operator's
# machine. The container is pointed at a provider endpoint reachable from it,
# which is also how a real remote host would be configured — by its own
# operator, not by Synara pushing secrets over the SSH channel.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
key="$here/demo_key"
name="synara-remote-authed"
port="${SYNARA_AUTHED_PORT:-2223}"
base="${SYNARA_PROVIDER_BASE_URL:-http://host.docker.internal:8317}"

[ -f "$key" ] || { echo "run ./up.sh first to generate the demo key" >&2; exit 1; }
cp "$key.pub" "$here/authorized_keys"

docker rm -f "$name" >/dev/null 2>&1 || true
docker build -q -t synara-remote-demo "$here" >/dev/null
docker run -d --name "$name" -p "$port:22" \
  --add-host host.docker.internal:host-gateway \
  -e ANTHROPIC_BASE_URL="$base" \
  synara-remote-demo >/dev/null

# `docker run -e` sets the variable for PID 1, but sshd builds a fresh login
# environment per session and does not inherit it — so an SSH session sees
# nothing. That is how a real host behaves too: whatever Synara starts over SSH
# gets the login environment, not the one the daemon happens to hold. Write it
# where a login shell will actually read it.
docker exec "$name" sh -c "printf 'ANTHROPIC_BASE_URL=%s\\n' '$base' > /home/synara/.ssh/environment \
  && chown synara:synara /home/synara/.ssh/environment \
  && chmod 600 /home/synara/.ssh/environment"

for _ in $(seq 1 30); do
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=no \
         -o UserKnownHostsFile=/dev/null -o ConnectTimeout=2 \
         -i "$key" -p "$port" synara@127.0.0.1 true 2>/dev/null; then
    echo "ready: ssh -i $key -p $port synara@127.0.0.1"
    echo "  provider base: $base"
    docker exec "$name" node -e '
      const http=require("http");
      const u=new URL(process.env.ANTHROPIC_BASE_URL);
      const r=http.get({host:u.hostname,port:u.port,path:"/",timeout:4000},(res)=>{
        console.log("  provider reachable from container: status "+res.statusCode);process.exit(0)});
      r.on("error",(e)=>{console.log("  provider UNREACHABLE: "+e.code);process.exit(0)});
      r.on("timeout",()=>{console.log("  provider TIMEOUT");process.exit(0)});'
    exit 0
  fi
  sleep 1
done

echo "container did not become reachable" >&2
docker logs "$name" >&2 || true
exit 1
