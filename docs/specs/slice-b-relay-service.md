# Slice B — Relay service: control protocol, grant verification, splice (v2)

Implements workstream B of `2026-08-13-hosts-as-account-entities.md` (ADRs 0006, 0008, 0010, 0013). New deployable: `apps/relay`. v2 is written against the contracts Slice A actually shipped.

> **Identity rule (non-negotiable).** The relay keys hosts by **`hostId` only**.
> `environmentId` is self-asserted by the host in its link proof and is unique
> only per org, so two users in different orgs can legitimately hold the same
> `environmentId`. Any routing, pairing, or audience decision made on
> `environmentId` is a cross-org takeover. It may be logged; it may never
> select a socket.

## 1. Shape

Bun + Hono service in `apps/relay`, structured like `apps/api` (`config.ts`, `app.ts`, `index.ts`, Dockerfile, Railway deploy). **No database.** All state is in-memory per instance:

- `hosts: Map<hostId, HostConnection>` — one live control socket per host (a second dial replaces the first, closing it `4409`).
- `pending: Map<spliceId, PendingSplice>` — client socket awaiting its host data socket, with a 10s timer.
- `usedGrantJtis: Map<jti, expiryMs>` — single-use enforcement, swept opportunistically; entries live only as long as the grant (≤60s + tolerance).

Single instance in v1 (ADR 0005 defers regional relays). Horizontal scaling is explicitly out of scope: the jti cache and host map are per-process, so two instances would let one grant splice twice. `RELAY_MAX_PAIRS` (default 1024) caps concurrent splices; over it, new clients get `1013`.

## 2. Verification (shared, from `@synara/contracts`)

The relay never sees host keys. Everything it verifies is API-signed and checked against `GET {API_BASE_URL}/api/v1/keys/jwks`:

- JWKS fetched at boot, refreshed hourly and on unknown `kid` (rate-limited to one refetch per 60s so an attacker cannot drive fetch storms). Last-known-good is retained on fetch failure — a JWKS outage must not drop live sessions or block splices for already-cached keys.
- Verification pins, for every token: `alg: EdDSA`, `typ`, `aud = SYNARA_RELAY_AUDIENCE`, `iss = API_ISSUER` (configured, exact), `clockTolerance: 60`, bounded lifetime (`exp > iat`, `exp - iat ≤ cap`, `iat ≤ now + 60`, and **`exp ≥ now`** — expiry is absolute, matching the API's `verifyBoundedJwt`).
- Claim decode uses the Effect schemas `RelayTicketClaims` / `GrantClaims`, so scope tuples and shapes are checked, not just signatures.

A shared package (`packages/relay-protocol`, new) carries the control-message schemas and close codes so `apps/relay`, `apps/server` (Slice C), and the harness cannot drift. Where a shape already exists in `@synara/contracts` (grant/ticket claims, revocation events) it is imported, not redefined.

## 3. Endpoints

- `GET /healthz` — liveness; reports connected host count and pair count.
- `GET /host/control?ticket=<jwt>` — host control socket. Verifies `synara-relay-ticket+jwt` (typ, `aud`, `iss`, scope `["relay:control"]`, ≤5min). `sub` is the **hostId** and is the only routing key. Replaces any existing socket for that host.
- `GET /client/session?grant=<jwt>` — client data socket. Verifies `synara-grant+jwt` (scope `["host:connect"]`, ≤60s), enforces single-use on `jti`, requires a live control socket for `claims.hostId`, then registers a pending splice and signals the host. Holds the socket until the host dials back or the 10s timer fires.
- `GET /host/data?splice=<id>` — host data socket. Matches a pending splice, pairs 1:1, and from then on forwards frames verbatim in both directions. The splice id is a 32-byte random value, single-use, and only meaningful to the host that was signaled (it arrives over that host's authenticated control socket, so it needs no separate auth — but the relay still checks the dialing socket belongs to the same host).

Query-param tokens are used because browsers cannot set headers on WebSocket upgrades. Tokens are ≤60s/≤5min and single-use where it matters; the relay must not log full query strings.

## 4. Control protocol (`packages/relay-protocol`)

JSON, versioned `{v: 1, type, ...}`, validated with Effect Schema on receipt:

- relay→host `splice_request {spliceId, hostId, userId, deviceJkt, expiresAtMs}` — dial `/host/data?splice=` within 10s.
- relay→host `revocation {events: RevocationEvent[]}` — fan-out from the API poller.
- relay→host `ping` / host→relay `pong` — 30s interval, 2 missed ⇒ socket closed `4408` and its pairs torn down.
- host→relay `ready {v:1}` — sent once after connect; lets the relay distinguish a live agent from a socket that merely opened.

Mint requests do **not** traverse the control socket: the mint handshake runs inside the spliced data socket (ADR 0013 — the relay is the carrier, never the parser).

## 5. Revocation fan-out

Poll loop every 5s: `GET {API_BASE_URL}/internal/revocations?after=<cursor>` with `Authorization: Bearer ${RELAY_SERVICE_TOKEN}`. The response is `{events, watermark}`; the relay **advances its cursor to `watermark` only** and delivers every returned event (duplicates are expected and safe — Slice A's watermark is xmin-bounded, so an event is never skipped, but it may repeat).

Delivery: each event goes to the control socket of `event.hostId` if connected. `host_unlinked` additionally closes that host's control socket (`4401`) and tears down its pairs — an unlinked host's ticket is void and its sessions must not survive. Events for unconnected hosts are dropped (the host re-verifies on reconnect, per ADR 0013).

Cursor lives in memory; on restart the relay resumes from the newest watermark (`?after=` omitted ⇒ API returns the current tail). Poll failures are logged and retried with backoff; the loop never dies.

## 6. Splice semantics

- **Backpressure**: forwarding pauses reads on one side when the peer's `bufferedAmount` exceeds `RELAY_HIGH_WATER_BYTES` (default 1 MiB) and resumes under half that. A peer that stays over the mark for 30s is closed `1013` — one slow client must not consume unbounded relay memory.
- **Close propagation**: either side closing closes the peer, forwarding the code where it is a valid client code, else `1001`.
- **Binary and text frames** both forward verbatim; the relay never parses payloads.
- **No multiplexing** (ADR: socket per session).

## 7. Close codes (shared constants)

`4401` bad/expired/void token · `4403` grant jti replay · `4404` host not connected or splice timeout · `4408` keepalive lost · `4409` superseded by a newer control socket · `4413` splice already claimed · `1013` overloaded/too slow.

## 8. Config

`RELAY_PORT`, `API_BASE_URL`, `API_ISSUER`, `RELAY_SERVICE_TOKEN` (required — fail closed at boot, like the API's `API_SIGNING_KEY`), `RELAY_MAX_PAIRS`, `RELAY_HIGH_WATER_BYTES`. Fail-closed config validation mirrors `apps/api/src/config.ts`.

## 9. Tests (vitest, no DB)

1. **Ticket auth**: valid ticket connects; wrong `typ`/`aud`/`iss`/scope, expired, forward-stamped, unknown `kid`, and API-issuer-mismatch all rejected `4401`.
2. **Grant auth**: valid grant splices; replayed `jti` rejected `4403`; expired rejected; grant for a host with no control socket rejected `4404`; grant whose `hostId` differs from the connected host never reaches that host.
3. **Splice lifecycle**: host dials back and frames flow both ways verbatim (text + binary); host never dials ⇒ client closed `4404` after the timer; second dial for the same splice rejected `4413`; close propagation both directions.
4. **Backpressure**: a stalled reader pauses the writer rather than growing memory unboundedly; sustained stall closes `1013`.
5. **Control protocol**: unknown/malformed messages are ignored (not fatal); keepalive loss closes `4408`; a second control dial supersedes the first with `4409`.
6. **Revocation**: poller advances only to `watermark`; duplicate events are delivered idempotently; `host_unlinked` closes the socket and tears down pairs; poll failure retries without killing the loop; restart resumes from the tail.
7. **Identity rule**: two hosts sharing an `environmentId` (different `hostId`) route independently — a grant for one never signals the other.
8. **Integration**: in-process relay + fake API (serves JWKS + revocations) + raw WS client and host exercising link→ticket→control→grant→splice→traffic→revoke→teardown.
9. **Load smoke**: 100 concurrent pairs echo without reordering or cross-talk (reliability-first).

## 10. Out of scope

Multi-instance coordination (documented single-instance constraint); metrics beyond structured logs; HTTP proxying or UI serving (ADR 0014); mint parsing (Slice C); regional relays (ADR 0005).
