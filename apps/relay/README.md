# Synara relay

The relay is a standalone Bun service that carries authenticated WebSocket
sessions between Synara clients and hosts. It has no database, serves no UI or
HTTP proxy, and treats spliced payloads as opaque bytes.

## Configuration

| Variable                 | Required | Default   | Purpose                                              |
| ------------------------ | -------- | --------- | ---------------------------------------------------- |
| `API_BASE_URL`           | yes      | —         | Account API base used for JWKS and revocation reads. |
| `API_ISSUER`             | yes      | —         | Exact issuer accepted on relay tickets and grants.   |
| `RELAY_SERVICE_TOKEN`    | yes      | —         | Bearer credential for `/internal/revocations`.       |
| `RELAY_PORT`             | no       | `8789`    | HTTP/WebSocket listener port.                        |
| `RELAY_MAX_PAIRS`        | no       | `1024`    | Maximum pending plus active splices.                 |
| `RELAY_HIGH_WATER_BYTES` | no       | `1048576` | Per-peer backpressure high-water mark.               |

Missing or malformed required values fail startup. The relay fetches JWKS
before listening, then retains the last-known-good keys across refresh errors.

## Railway / container deployment

Build with the repository root as the Docker context and
`apps/relay/Dockerfile` as the Dockerfile. Configure Railway's public port as
`RELAY_PORT` and keep the service at one replica: host presence, grant replay
state, and splice state are intentionally process-local in this version.

The deployed relay is the `relay` service in the Railway project that also
hosts the account API. It auto-deploys from the same branch as the API, serves
`https://relay.synara.vrbty.dev`, and is configured with
`API_BASE_URL=https://api.synara.vrbty.dev`,
`API_ISSUER=https://api.synara.vrbty.dev/api/v1`, `RELAY_PORT=8789`, a
`/healthz` healthcheck, and the `RELAY_SERVICE_TOKEN` shared with the API
service. The relay fetches JWKS before it listens, so it restarts until the
API is reachable; deploy or repair the API first.

The only ordinary HTTP endpoint is `GET /healthz`. `/host/control`,
`/client/session`, and `/host/data` require WebSocket upgrades.

## Runtime note: Bun replaces `ws`

Under Bun the `ws` package resolves to Bun's own shim over its native
WebSocket, not the npm package the test suite (Vitest on Node) exercises. The
shim exposes no `_socket`, so transport-level `pause()` is a no-op there.
`wsSocket.ts` therefore holds pre-pairing frames itself instead of relying on
the transport to pause; without that, a client's first frame (its mint
request) was dropped by the deployed image and every relay session hung.
The in-process suite cannot see this — it runs on Node — which is what
`apps/e2e/docker` (real images, real network boundary) exists to catch.
