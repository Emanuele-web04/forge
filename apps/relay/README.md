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

The only ordinary HTTP endpoint is `GET /healthz`. `/host/control`,
`/client/session`, and `/host/data` require WebSocket upgrades.
