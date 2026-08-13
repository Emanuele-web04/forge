# Slice B — Relay service: control protocol, grant verification, splice

**Draft — finalized after Slice A lands (depends on `packages/contracts/src/hostAuth.ts` shapes and `/internal/revocations`).** Implements workstream B per ADRs 0006, 0008, 0010, 0013. New deployable: `apps/relay`.

## Shape

Bun + Hono service in `apps/relay`, mirroring `apps/api`'s structure (config.ts, index.ts, Dockerfile, Railway deploy). **No database.** State is in-memory per instance: connected host control sockets, pending splices, grant jti cache. Horizontal scaling is out of scope for v1 (one instance; the design keeps it stateless enough to add a shared jti cache later — noted, not built).

## Endpoints (all WebSocket except health)

- `GET /healthz` — liveness.
- `GET /host/control` — host control socket. Auth at upgrade: `synara-relay-ticket+jwt` (Slice A §9 — obtained by the host from `POST /hosts/:id/relay-ticket` with its HostProof), verified statelessly against the API's `/keys/jwks`. The relay never sees host keys. Ticket refresh: reconnects fetch a fresh ticket; a live control socket is not re-checked (revocation of a host lands as `host_unlinked` via the revocation feed, which the relay applies by dropping that host's control socket and pairs).
- `GET /client/session?grant=<jwt>` — client data socket. Relay verifies grant (signature via JWKS, exp, aud, `scope: host:connect`), enforces jti single-use in the in-memory cache (60s TTL), signals the target host's control socket, holds the client socket pending.
- `GET /host/data?splice=<spliceId>` — host dials back per splice signal; relay pairs it with the pending client socket and from then on forwards opaque frames 1:1 both ways, with per-pair backpressure (pause reads when the peer's bufferedAmount exceeds the high-water mark). Close semantics: either side closing closes the pair with matching code where possible.

## Control protocol (host control socket, JSON messages)

Small and versioned (`{v: 1, type, ...}`):

- relay→host `splice_request {spliceId, grantJti, userId, deviceJkt, expiresAt}` — host must dial `/host/data?splice=` within 10s or the pending client is dropped with close code `4404`.
- relay→host `revocation {events: [{kind, subject, hostId}]}` — fan-out from the API poller (below).
- host→relay `ping` / relay→host `pong` — keepalive (30s interval, 2 missed = dead).
- Mint requests do NOT traverse the control socket: the mint handshake runs inside the spliced data socket (client speaks it to the host directly once spliced — ADR 0013's "relay forwarding is just the carrier"). The relay never parses spliced frames.

## Revocation fan-out

Background loop polls `GET /internal/revocations?after=<cursor>` on the API (auth: `RELAY_SERVICE_TOKEN`) every 5s. The response is `{events, watermark}` (Slice A §4.6): the relay advances its cursor to `watermark` only (the lag-safe max id), delivers all events, and treats duplicate delivery as normal — signals are idempotent re-verify prompts. `host_unlinked` additionally makes the relay drop that host's control socket and all its pairs. Cursor in memory only — on restart, resume from latest watermark (hosts re-verify sessions on control-socket reconnect, which covers the gap).

## Close codes

`4401` bad/expired grant or ticket · `4403` jti replay · `4404` host not connected / splice timeout · `4409` splice already claimed · `1013` overloaded. Shared constants in `packages/contracts/src/relayProtocol.ts` (new; also carries the control-message Effect Schemas).

## Config

`RELAY_PORT`, `API_BASE_URL` (JWKS + revocations), `RELAY_SERVICE_TOKEN`, `RELAY_MAX_PAIRS` (default 1024), high-water mark bytes. JWKS fetched at boot + refreshed hourly and on unknown-kid.

## Tests

Vitest, no DB. Unit: grant verify (signature/exp/aud/jti-replay via injected JWKS), control protocol framing, splice pairing state machine (timeout, double-claim, close propagation), backpressure (slow reader pauses fast writer). Integration: in-process relay + fake API (serves JWKS + revocations) + two raw WS clients exercising the full splice + revocation fan-out. Load smoke: 100 concurrent pairs echo traffic without frame reordering (reliability-first priority).

## Out of scope

Multi-instance coordination; metrics/observability beyond structured logs; HTTP proxying (ADR 0014); mint parsing (host-side, Slice C); regional relays (ADR 0005 deferral).
