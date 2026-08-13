# Slice A — Account API: ownership, keypair link, grants, revocation (v2)

Implements workstream A of `2026-08-13-hosts-as-account-entities.md` (ADRs 0002, 0006, 0011, 0012, 0013, 0015). v2 after adversarial review (25 confirmed findings resolved; see git history for v1).

**Landability**: Slice A is **additive**. The legacy surface (`POST /hosts`, `host_tokens`, `deviceCredentialStore`, `RegisterHostRequest/Response`, `registered_by_user_id`) stays intact and functional so `packages/shared` and `apps/server` keep compiling and working untouched. The cutover (ADR 0012) happens when **Slice C** switches the host to keypair auth — that PR removes the legacy surface, drops `host_tokens`, and force-re-links deployed hosts. Slice A only _adds_: new tables, new columns, new routes, new contracts.

## 1. Schema changes (`apps/api/src/db/schema.ts`)

One additive migration (`bun run --cwd apps/api db:generate`).

### `hosts` — modified (additive only)

- ADD `owner_user_id text NOT NULL` — the authorization key. Backfill from `registered_by_user_id` (acceptable as a one-time pre-launch bootstrap: it's the only signal we have, and every host re-links in Slice C anyway, which re-establishes ownership from the live link flow). `registered_by_user_id` **stays** until Slice C.
- ADD `discoverable boolean NOT NULL DEFAULT true`.
- ADD `public_key_jwk jsonb` (nullable — null = "unlinked": cannot mint, cannot be granted to, host-auth refused). Ed25519 JWK `{kty:"OKP", crv:"Ed25519", x}`.
- ADD `key_generation integer NOT NULL DEFAULT 0` — 0 = never linked; link/complete sets it to `max(current,0)+1`. Exposed to the host in the link response and in host-facing reads (F20).
- Endpoints jsonb: migration strips `transport: "public"` entries from existing rows; contracts narrow `AccountHostTransport` to `"lan" | "tailscale"` (checked: nothing constructs `"public"` today).
- ADD index on `(owner_user_id)`. KEEP unique `(owner_org_id, environment_id)` and everything else.

### `devices` — new

- `id uuid PK defaultRandom`, `user_id text NOT NULL`
- `public_key_jwk jsonb NOT NULL` — **ES256 (P-256) or EdDSA (Ed25519)** JWK. P-256 must be allowed: Apple Secure Enclave cannot do Ed25519 (F23).
- `jkt text NOT NULL` — RFC 7638 thumbprint. Uniqueness: **partial unique index on `(user_id, jkt) WHERE revoked_at IS NULL`** — scoped per-user (a jkt is a public value, not a claim ticket) and re-registrable after revocation (F10).
- `display_name text NOT NULL`, `platform text NOT NULL` enum `darwin|ios|linux|windows|web`
- `created_at`, `last_used_at`, `revoked_at timestamptz`

### `link_challenges` — new

- `id uuid PK defaultRandom`
- `nonce text NOT NULL` (32B base64url)
- `owner_user_id text`, `owner_org_id text` — **nullable**: bound at `start` for session-initiated challenges; bound at `approve` for device-code challenges (F6, F13)
- `host_id uuid`, `environment_id text` — nullable; bound when known (F6)
- Device-code columns (nullable, only for the headless flow): `device_code_hash text` (sha256 of the high-entropy CLI credential), `user_code text` (short display code, uniquely indexed among unexpired), `approved_at timestamptz`
- `created_at`, `expires_at` (start: now+10min), `consumed_at timestamptz`
- Consumption is atomic: `UPDATE ... SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING *` — the returned row is the authorization (race-safe, F19).
- Opportunistic cleanup of expired rows on issuance.

### `revocation_events` — new

- `id bigserial PK`, `host_id uuid NOT NULL` — **plain column, NO foreign key** (F2/F21: the queue must survive host deletion; it's append-only and short-lived)
- `kind text NOT NULL` enum `discoverability_off | org_departure | device_revoked | host_unlinked`
- `subject text` (userId or device jkt, kind-dependent), `created_at timestamptz NOT NULL now()`
- Cursor contract (F14): bigserial ids become visible out of commit order. Consumers MUST poll `WHERE id > cursor` but only advance their cursor past rows with `created_at < now() - 5s`, re-reading the trailing window and de-duplicating by id. **Duplicate delivery is expected and safe** (signals are idempotent "re-verify" prompts). This contract is stated in the route docs and tested.
- Opportunistic cleanup: rows older than 24h deleted on write.

## 2. API signing key

- Ed25519 from `API_SIGNING_KEY` (base64url 32B seed). **Required — fail closed at boot** for the WorkOS provider (added to `REQUIRED_VARS`, mirroring `assertDevIdentityAllowed`'s posture); only the dev provider may auto-generate an ephemeral key, with a logged warning (F9).
- `API_SIGNING_KEY_PREVIOUS?` for rotation; both served from `GET /api/v1/keys/jwks` (public). `kid` = RFC 7638 thumbprint. §8 tests that two boots with the same env produce the same `kid`.

## 3. Wire contracts

New `packages/contracts/src/hostAuth.ts` (Effect Schema, dual const/type idiom, re-exported from index): all JWT claim schemas of §9, claim-name constants, `typ` constants, plus request/response schemas: `LinkStartRequest/Response`, `LinkCompleteRequest/Response`, `LinkDeviceStartResponse`, `LinkDeviceApproveRequest`, `LinkDeviceTokenRequest/Response`, `RegisterDeviceRequest/Response`, `ListDevicesResponse`, `GrantRequest/Response`, `RelayTicketResponse`, `HostAuthorizationSnapshot`, `RevocationEventsResponse`.

`packages/contracts/src/account.ts` — **additive**: `AccountHost` gains `ownerUserId`, `discoverable`, `linked: boolean`, `keyGeneration: number`; keeps `registeredByUserId` until Slice C. `AccountHostTransport` narrows to `"lan" | "tailscale"`. New `AccountErrorCode` members: `not_host_owner`, `host_not_linked`, `device_revoked`, `device_not_registered`, `challenge_expired`, `challenge_consumed`, `approval_pending`, `bad_proof`.

## 4. Routes

Existing idiom throughout: inline gates, `Schema.decodeUnknownSync`, `errorResponse`. Legacy routes untouched.

### 4.1 Link flow — ONE protocol: DB-row nonce, no challenge JWT (F4/F12/F17 resolved)

There is no API-signed challenge JWT. The `link_challenges` row is the single source of truth; the proof binds `challengeId` + `nonce` directly.

**`POST /hosts/link/start`** — session-authed (`requireOrgSession`). Body `{environmentId?, name?, platform?, kind?}`.

- If `environmentId` given and a row exists for `(orgId, environmentId)`: caller MUST be its owner, else `409 environment_already_linked` (F3/F8 — no org-member takeover). The existing row is NOT modified — no key clearing, no owner rewrite; `start` is side-effect-free on existing hosts beyond creating the challenge row.
- If `environmentId` given and no row exists: insert host row `{ownerUserId: caller, ownerOrgId, environmentId, name, platform, kind, discoverable: true, publicKeyJwk: null, keyGeneration: 0}`.
- If `environmentId` absent (host will self-report it in the proof): no host row yet.
- Insert challenge `{nonce, ownerUserId: caller, ownerOrgId, hostId?, environmentId?}`. Response `{challengeId, nonce, hostId?, expiresAt}`.

**`POST /hosts/link/complete`** — unauthenticated (the proof is the auth). Body `{challengeId, proof}`; proof = `synara-host-link+jwt` (§9).
Verification order: atomically consume challenge (§1) → decode proof, check bounded lifetime → verify signature TOFU against the `publicKeyJwk` claim → `proof.challengeId === challengeId` and `proof.nonce === challenge.nonce` → challenge has owner bound (device-code challenges must be approved) → environment binding: if `challenge.environment_id` set, `proof.sub` must equal it; else adopt `proof.sub` as the environmentId → resolve host row: `challenge.host_id` if bound, else find-or-insert by `(challenge.owner_org_id, environmentId)`; if an existing row's owner ≠ challenge owner → `409` (nothing consumed the victim's key — challenge burn is the only side effect).
Effects (one transaction): set `public_key_jwk`, `key_generation += 1`; **unlink every OTHER hosts row (any org) with the same `environment_id`** — clear key, `discoverable = false`, emit `host_unlinked` (F15: a machine is linked in exactly one place; no orphan rows serving an old account).
Response `{host}` including `keyGeneration` (F20).

**Device-code flow (headless, RFC 8628-shaped — F5/F13/F18 resolved):**

- `POST /hosts/link/device` — unauthenticated, per-IP rate-limited. Mints `deviceCode` (32B base64url — the CLI's real credential, stored hashed) + `userCode` (8 chars from a 32-symbol alphabet, ~40 bits, display only) on a challenge row with no owner bound. Response `{deviceCode, userCode, verificationUri, expiresAt, interval: 5}`.
- `POST /hosts/link/approve` — session-authed. Body `{userCode}`. Binds `ownerUserId`/`ownerOrgId` to the challenge, sets `approved_at`. Per-IP rate limit (10/min) bounds userCode guessing; unexpired userCodes are unique.
- `POST /hosts/link/device/token` — unauthenticated. Body `{deviceCode}` (hash lookup). Returns `428 approval_pending` until approved, then `{challengeId, nonce}` (single delivery), after which `link/complete` proceeds identically.

### 4.2 Host-authenticated calls

Gate `authenticateHost(c)`: header `Authorization: HostProof <jwt>` (§9 `synara-host-proof+jwt`), verified against `hosts.public_key_jwk` + `key_generation` match; refuses unlinked hosts; updates `last_seen_at`.
Scope correction (F11/F25): the ONLY legacy host-token call sites are `PATCH /hosts/:id` and the host-token branch of `DELETE /hosts/:id` (plus `rotate` inside register). Those legacy paths stay as-is until Slice C; the new gate serves only the NEW routes below. **`POST /usage` keeps `requireOrgSession`** — usage accrues to the person, a HostProof carries no userId; it is explicitly out of the HostProof migration.

- `PUT /hosts/:id/endpoints` — HostProof. Full-replace endpoint set.
- `POST /hosts/:id/relay-ticket` — HostProof. Returns `synara-relay-ticket+jwt` (§9).
- `GET /hosts/:id/authorization` — HostProof. Returns `{discoverable, ownerUserId, orgId, ownerInOrg}` — the policy snapshot Slice C uses to re-verify live sessions on revocation signals and reconnect (F22).

### 4.3 Devices

- `POST /devices` — session-authed. Body `{proof}` = `synara-device-register+jwt` (§9) **signed by the device key — proof of possession required** (F10); verified TOFU against the embedded JWK, `sub` must equal the session userId (prevents cross-user replay). Upsert on active `(user_id, jkt)`; a revoked pair may re-register as a fresh row. Response: device record.
- `GET /devices` / `DELETE /devices/:id` — session-authed, own devices only. DELETE sets `revoked_at` and emits `device_revoked` for **every host in every org the user is a member of** (F7 — over-notify; hosts re-verify cheaply). Slice E's Sync-Key rotation hooks here.

### 4.4 Grants

`POST /hosts/:id/grant` — session-authed. Body `{deviceJkt}`.
Authz chain: device with `deviceJkt` is registered, unrevoked, and belongs to the session user → host is linked (`public_key_jwk` present) → session user is owner, OR (`discoverable` AND caller in `owner_org_id` with `freshMembership: true` AND **the owner is still a member of `owner_org_id`** — owner membership resolved via WorkOS with the existing 60s org cache; refusal on departed owner also lazily emits `org_departure` (F22)).
Response: `synara-grant+jwt` (§9), 60s, single-use. Single-use = consumer-side jti dedupe (relay/host in-memory 60s cache); v1 runs a single relay instance so the cache is sound — multi-instance jti sharing is a documented Slice B deferral. Per-user rate limit.

### 4.5 Host management

- `GET /hosts` — hosts where caller is owner OR (`discoverable` AND same org). Response marks `mine`.
- `PATCH /hosts/:id` (rename, toggle `discoverable`) — owner-session only (legacy host-token branch remains until C). Discoverability→off emits `discoverability_off`.
- `POST /hosts/:id/unlink` — owner-session OR HostProof (a signing-out machine retires itself, ADR 0015): clears `public_key_jwk`, `key_generation += 1`, `discoverable = false`, emits `host_unlinked`. Row survives (F15).
- `DELETE /hosts/:id` — owner-session: emits `host_unlinked` FIRST (no FK, so the event survives), then deletes the row (F2/F21).

### 4.6 Internal

`GET /internal/revocations?after=<id>` — `RELAY_SERVICE_TOKEN` auth (constant-time compare). Returns events + the §1 cursor contract documented in the response envelope (`{events, watermark}` where watermark = safe cursor: max id among rows older than the 5s lag).

## 5. Identity layer

All additive: `deviceCredentialStore.ts` and existing interfaces stay until Slice C. New in `apps/api/src/identity/`: `signing.ts` (jose helpers: EdDSA + ES256 verify, JWK thumbprints, JWKS assembly), `hostKeyRegistry.ts` (challenges, link, HostProof verify), `deviceRegistry.ts`, `grantIssuer.ts` (grants + relay tickets), `revocationLog.ts`. Interfaces added to `interfaces.ts`; wired in `identity/index.ts` and route deps.

## 6. Threat-model precision (F16)

ADR 0011's "a compromised API cannot fabricate access" is amended (see ADR): the API is the _authorization_ authority, so API-key compromise can authorize sessions to linked, discoverable-or-owned hosts. What the design guarantees: **relay** compromise fabricates nothing (it signs nothing); API compromise cannot impersonate a host, cannot decrypt Host Secrets, and cannot reach a host silently — every session requires the host online and minting, and Slice C hosts enforce their own last-known policy at mint time (owner userId recorded at link; local `discoverable` mirror refuses non-owner grants when off). Sessions are surfaced in the host UI.

## 7. Config

`API_SIGNING_KEY` (required, WorkOS provider — §2), `API_SIGNING_KEY_PREVIOUS?`, `RELAY_SERVICE_TOKEN` (required for `/internal/*`; no dev default in workos mode).

## 8. Tests

Existing patterns (real Postgres via `TEST_DATABASE_URL`, fakeWorkos). Matrix:

1. **Link**: start→complete happy path (bound + unbound environmentId); atomic double-complete race (one winner); expired/consumed challenge; bad TOFU sig; nonce mismatch; **org-member calling start with another member's environmentId → 409 and victim's key_generation unchanged** (F8); re-link by owner bumps generation and old HostProofs die; complete unlinks same-environmentId rows in other orgs and emits `host_unlinked` (F15).
2. **Device-code**: mint→approve→token→complete; token before approve → 428; expired code; approve rate-limiting; userCode uniqueness among live challenges.
3. **HostProof**: valid passes; stale exp / wrong aud / unlinked host / stale generation → 401.
4. **Devices**: PoP required — registering a jkt without possession fails; **user B cannot register user A's jkt** (scoped uniqueness makes it a non-event: B gets their own row only with possession, F10); revoked jkt re-registers; revoke emits `device_revoked` for org-mates' hosts too (F7).
5. **Grants**: owner; org member iff discoverable; non-member 403; revoked/unregistered/foreign device 403; unlinked host 409; **departed owner → refusal + `org_departure` event** (F22); grant verifies against JWKS and carries `cnf.jkt`.
6. **Host mgmt**: GET visibility matrix; PATCH/DELETE/unlink owner-only; discoverability-off, unlink, and delete each emit their event, **delete's event survives the row deletion** (F2).
7. **Revocations feed**: cursor + watermark semantics (an event committed late with a lower id is still delivered within the lag window); service-token auth; 24h cleanup.
8. **JWKS**: stable `kid` across two boots with same env (F9); previous-key verification during rotation; workos provider without `API_SIGNING_KEY` refuses to boot.
9. **Coexistence**: legacy `POST /hosts` register + host-token PATCH still work unchanged; migration on a seeded pre-v2 DB backfills `owner_user_id` and strips `"public"` endpoints.

## 9. JWT shapes

Conventions (t3code-derived): jose; header pins `typ`; issuers/audiences exact-matched; `clockTolerance: 60`; bounded lifetime = `exp > iat ∧ exp − iat ≤ cap ∧ iat ≤ now + 60s`; UUIDv4 `jti`. **Host and API keys: Ed25519 (EdDSA). Device keys: ES256 (P-256, Secure Enclave) or EdDSA** (F23). API issuer string = `API_PUBLIC_URL`.

| typ                             | signer            | aud                                 | cap | purpose                                                                                                                                                                                                                                                                                             |
| ------------------------------- | ----------------- | ----------------------------------- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `synara-host-link+jwt`          | host key (TOFU)   | API issuer                          | 5m  | link proof: `iss "synara-host:<envId>"`, `sub` envId, `challengeId`, `nonce`, `publicKeyJwk`, `name`, `platform`, `appVersion?`                                                                                                                                                                     |
| `synara-host-proof+jwt`         | host key          | API issuer                          | 60s | API auth: `iss "synara-host:<envId>"`, `sub` hostId, `keyGeneration` (F20: iss/sub fixed)                                                                                                                                                                                                           |
| `synara-device-register+jwt`    | device key (TOFU) | API issuer                          | 60s | PoP registration: `iss "synara-device"`, `sub` userId, `publicKeyJwk`, `displayName`, `platform`                                                                                                                                                                                                    |
| `synara-grant+jwt`              | API key           | `"synara-relay"` (hosts accept too) | 60s | `sub` userId, `hostId`, `environmentId`, `cnf:{jkt}`, `scope:["host:connect"]`                                                                                                                                                                                                                      |
| `synara-relay-ticket+jwt`       | API key           | `"synara-relay"`                    | 5m  | `sub` hostId, `environmentId`, `keyGeneration`, `scope:["relay:control"]`                                                                                                                                                                                                                           |
| `synara-mint-request+jwt`       | device key        | `"synara-host:<envId>"`             | 2m  | Slice C, fully defined now (F23): `iss "synara-device"`, `sub` userId, `publicKeyJwk`, `grant` (full grant JWT echoed). Host verifies: grant sig vs API JWKS + exp + `hostId` = self + jti unseen (60s cache); request sig vs embedded JWK; thumbprint(JWK) === grant `cnf.jkt`; bounded lifetimes. |
| `synara-session-credential+jwt` | host key          | `"synara-session"`                  | 1h  | Slice C: `iss "synara-host:<envId>"`, `sub` userId, `cnf:{jkt}`, `keyGeneration`, `scope:["host:connect"]`. Presented with an RFC 9449 DPoP proof (`typ "dpop+jwt"`, signed by device key, `htu`/`htm`/`jti`/`iat`, `ath` = SHA-256 of the credential).                                             |

No challenge JWT exists (F12): the challenge is a DB row; the proof binds `challengeId` + `nonce`.

## 10. Out of scope

Relay service (B); host-side implementation of link/mint/dial (C — including removal of the legacy surface + `host_tokens` drop); clients (D); secrets sync (E); WorkOS membership webhooks (lazy org-departure only); multi-instance grant-jti sharing (B deferral).

## Verification

`bun fmt && bun lint && bun typecheck` + `bun run test` (apps/api needs `TEST_DATABASE_URL`, docker-compose Postgres). One final pass.
