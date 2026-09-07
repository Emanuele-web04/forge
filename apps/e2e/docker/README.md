# Local end-to-end run across a real network boundary

`bun run --cwd apps/e2e test:docker` (from anywhere in the repo) stands up the
remote-host stack the way it is deployed and drives it from a container that
can reach the host only through the relay.

| Piece       | Where it runs                 | How                                                            |
| ----------- | ----------------------------- | -------------------------------------------------------------- |
| Postgres    | Docker                        | `postgres:18`                                                  |
| Account API | Docker                        | `apps/api/Dockerfile`, dev identity provider, published on LAN |
| Relay       | Docker                        | `apps/relay/Dockerfile`, published on LAN                      |
| Host        | **this machine**, from source | `apps/server`, enrolled via `synara auth --device-code`        |
| Client      | Docker, isolated              | `Dockerfile.client`; an iptables pinhole to API + relay only   |

The API's public URL is the machine's LAN IP. Every JWT in the system (grants,
tickets, mint requests, DPoP) is bound to that string as issuer or audience, so
the host on this machine and the client in the container must name it
identically — the LAN IP is the one address both can route to.

## What it proves

`client.ts` runs the production protocol from inside the isolated container:
device key + proof-of-possession registration, single-use grant, relay splice,
host mint handshake, DPoP authorize, then real Synara RPC (`server.getConfig`,
`server.getEnvironment`) over the bridged session — text and binary framed,
sequential and concurrent. It then checks the three things the per-service
suites cannot: a spent grant is refused with the documented close code, device
revocation kills the live session through API → relay → host, and after the
relay is restarted under the live host a fresh device still gets through.

After the transport scenarios, the client runs a **real agent turn**: the
production orchestration commands the web composer sends (`project.create`,
`thread.create`, `thread.turn.start` with `claudeAgent`), observed on the
production thread event stream, with the model reply matched on a nonce the
prompt asked the model to echo. The provider call runs on the host with
whatever Claude credential this machine has — the isolated client never holds
one, which is the point. It spends provider quota; `SYNARA_E2E_AGENT=0` skips
it, and `SYNARA_E2E_AGENT_MODEL` picks the model (default `claude-sonnet-5`).

Isolation is asserted, not assumed. A positive-control container proves the
host's port IS reachable from Docker; the isolated client proves it is NOT
reachable from inside the pinhole, along with `host.docker.internal`, the API
container's name, and the internet.

## Prerequisites

Build the three images once from the repository root (the deps layer is
shared, so the second and third are fast):

```
docker build -f apps/api/Dockerfile          -t synara-e2e/api:local .
docker build -f apps/relay/Dockerfile        -t synara-e2e/relay:local .
docker build -f apps/e2e/docker/Dockerfile.client -t synara-e2e/client:local .
```

The host serves `apps/web/dist`, so build the web app if it is missing. Ports
8788 (API), 8789 (relay) and 3899 (host) must be free.

`SYNARA_E2E_KEEP=1` leaves everything running for inspection. Logs, including
each container's stdout and the host's, land in `/tmp/synara-e2e/logs`.

`SYNARA_E2E_STACK_ONLY=1` starts only Postgres, the API and the relay and
leaves them running, printing the `SYNARA_ACCOUNT_URL` / `SYNARA_RELAY_URL`
to point desktop apps at. Sign-in codes appear in the API container's logs
(`docker logs -f synara-e2e-api | grep dev-identity`); any email works.
