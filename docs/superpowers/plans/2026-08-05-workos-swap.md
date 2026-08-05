# WorkOS Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Replace the BetterAuth identity layer in `apps/api` with WorkOS AuthKit, keeping the host registry, host tokens, contracts shape, CLI UX, and relay seam intact. End state: PR #42 green with the swap.

**Architecture:** WorkOS owns identity (hosted AuthKit pages, CLI Auth device flow, their JWKS). `apps/api` becomes a UI-less registry service that (a) proxies the one API-key-requiring device-authorization call, and (b) verifies WorkOS access-token JWTs. `hosts.userId` holds WorkOS user ids (plain text, no FK). CLI stores access+refresh tokens and refreshes on expiry.

**Verified WorkOS facts (2026-08):**

- `POST https://api.workos.com/user_management/authorize/device` — requires API key (secret) + `client_id`. Returns `{device_code, user_code, verification_uri, verification_uri_complete, expires_in (300), interval (5)}`.
- `POST https://api.workos.com/user_management/authenticate` — public (`client_id` only). Device grant: `grant_type: "urn:ietf:params:oauth:grant-type:device_code"` + `device_code`. Errors 400: `authorization_pending`, `slow_down`, `access_denied`, `expired_token`, `invalid_grant`, ... Success: `{user, organization_id?, access_token, refresh_token, authentication_method, ...}`.
- Refresh: same authenticate endpoint, `grant_type: "refresh_token"` + `refresh_token` + `client_id` (public).
- Access tokens are JWTs signed by JWKS at `https://api.workos.com/sso/jwks/{client_id}`; claims include `sub` (user id), `sid`, `exp`, optional `org_id`/`role`/`permissions`.
- Access tokens are short-lived (~5 min default); refresh tokens are single-use, rotated on refresh.

## Global Constraints

- `bun fmt` / `bun lint` / `bun typecheck` full pass at the end; tests via `bun run test` (never `bun test`).
- No secrets committed; `WORKOS_API_KEY` env only. Client id is public.
- Integration tests must not call real WorkOS: `ApiConfig` gains `workosApiUrl` (default `https://api.workos.com`) and `workosJwksUrl` override so tests can point at a local stub; token verification uses injectable JWKS (tests sign JWTs with their own key + serve a local JWKS).
- Keep migration lineage: append a new migration (`0001_workos_swap`); never edit `0000_account_backend_init`.
- `relay_grants` still NOT created. No WebSockets/heartbeats. Account features stay inert without `SYNARA_ACCOUNT_URL`.
- Commits: conventional, NO AI attribution.

---

### Task 1: apps/api — WorkOS auth core, config, schema migration, delete BetterAuth + UI

**Files:**

- Rewrite: `apps/api/src/config.ts` (+ test) — required: `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, `ACCOUNT_BASE_URL`; optional `PORT`, `workosApiUrl`/`workosJwksUrl` overrides (env `WORKOS_API_URL`, `WORKOS_JWKS_URL`). DELETE: BETTER_AUTH_SECRET, all provider pairs, email config, allowlist, `enabledAuthMethods` (instance reports differently now).
- Create: `apps/api/src/workos.ts` (+ test) — `createWorkosAuth(config)` returning `{ verifyAccessToken(token): Promise<{userId, sessionId}> }` using `jose` `createRemoteJWKSet(config.workosJwksUrl ?? https://api.workos.com/sso/jwks/{clientId})` + `jwtVerify`; `getUser(userId)` via WorkOS API (API key) for /me; `requestDeviceAuthorization()` proxying `POST {workosApiUrl}/user_management/authorize/device` with API key. Add `jose` dep; REMOVE `better-auth` dep.
- Delete: `apps/api/src/auth.ts`, `apps/api/src/auth.test.ts`, `apps/api/src/db/auth-schema.ts`, entire `apps/api/ui/`, `apps/api/src/staticUi.ts`; strip ui build from package.json (build script: no-op or drop; `test` no longer builds UI).
- Modify: `apps/api/src/db/schema.ts` — remove auth-schema re-export; `hosts.userId` becomes plain `text("user_id").notNull()` (WorkOS id, no FK). Generate migration `0001_workos_swap`: drop FK, drop tables `user, session, account, verification, device_code, jwks` (verify generated SQL drops in dependency order); rename via journal tag like Task "rename" did before.
- Modify: `apps/api/.env.example`, `apps/api/README.md` — WorkOS setup (dashboard: create AuthKit app, enable CLI Auth, providers are dashboard toggles; env vars; note JWKS is WorkOS's; delete SMTP/Resend/OAuth-registration/JWKS-trap sections; keep registry + Railway sections).

**Verify:** config tests green; db schema test still green after migration on compose pg (existing db AND fresh db); `bunx tsc --noEmit` clean. Commit `feat(api): workos identity core — config, jwt verification, schema migration, drop betterauth+ui`.

---

### Task 2: apps/api — routes on WorkOS, app assembly, integration tests

**Files:**

- Modify: `apps/api/src/routes/v1.ts` (+ `v1.test.ts`) — deps become `{ workos, db, config }`. Device-token auth → `workos.verifyAccessToken(bearer)` (401 on failure). DELETE `/sessions` routes (WorkOS owns sessions; desktop phase revisits). `GET /me` → JWT `sub` + `workos.getUser`. `GET /instance` → `{ version, authMode: "workos", clientId }` (clients need clientId to poll WorkOS directly). NEW `POST /auth/device` (no auth) → `workos.requestDeviceAuthorization()` passthrough (this is the API-key proxy; rate-limit lightly — simple in-memory token bucket, ~10/min/IP). Host-token auth (`hostAuth.ts`) unchanged.
- Modify: `apps/api/src/app.ts` (+ test), `src/index.ts` — no auth handler mount, no static UI; non-/api paths → minimal 200 text page pointing at the repo; assemble `createWorkosAuth`.
- Contracts (`packages/contracts/src/account.ts` + test): `InstanceInfo` → `{ version, authMode: Literal("workos"), clientId }` (replace authMethods/emailDelivery/signupRestricted); add `DeviceAuthorizationResponse` schema (snake→camel as before); remove `ListSessionsResponse`/`AccountSessionSummary`; keep everything else.
- Tests: v1.test.ts reworked — build a local **fake WorkOS**: test generates an ES256/RS256 keypair, serves JWKS + `/user_management/*` endpoints on an ephemeral Hono server, config points `workosApiUrl`/`workosJwksUrl` at it. All existing authz/rotation/isolation tests keep their assertions with locally-signed JWTs (`sub: userA`). Add: expired JWT → 401; wrong-issuer/garbage token → 401; `/auth/device` proxy passes through and never leaks the API key.

**Verify:** full apps/api suite green against compose pg; tsc clean. Commit `feat(api): registry routes verify workos tokens; device proxy; drop session routes`.

---

### Task 3: shared client + CLI on WorkOS device flow with refresh

**Files:**

- Modify: `packages/shared/src/account.ts` (+ test) — `requestDeviceCode()` now calls `{baseUrl}/api/v1/auth/device`; `pollDeviceToken(deviceCode, opts)` posts to `{workosApiUrl}/user_management/authenticate` with device grant + `clientId` (client gains `workosApiUrl`+`clientId` options, sourced from `/instance`); handles `authorization_pending`/`slow_down`/deadline as today; returns `{accessToken, refreshToken, user}`. NEW `refreshAccessToken(refreshToken)` (public, rotates). `me/listHosts/...` unchanged (bearer = WorkOS access token).
- Modify: `apps/server/src/accountAuth.ts` (+ test) — credentials shape v2: `{ accountUrl, workosClientId, accessToken, refreshToken, hostToken?, hostId? }` (0600 as before; old shape → treat as signed out). `runAuthLogin`: fetch `/instance` → device flow → save → register host (unchanged). NEW `withFreshAccessToken` helper: on 401 or expired `exp`, call refresh, persist rotated pair, retry once; used by `runStatus`, `refreshHostRegistration`, logout. `runAuthLogout`: revoke host (host token) + delete file (no session-revoke endpoint anymore — WorkOS sessions expire; note in output).
- Startup refresh in `main.ts`: unchanged call path; goes through `withFreshAccessToken`.

**Verify:** shared + accountAuth suites green (mocked fetch / fake WorkOS responses incl. refresh rotation + single-use-refresh failure → signed-out message); tsc clean. Commit `feat(shared,server): cli auth via workos device grant with refresh rotation`.

---

### Task 4: docs, spec update, full gate, E2E-with-stub, push + PR update

- Update `docs/superpowers/specs/2026-08-03-account-backend-design.md`: auth section rewritten for WorkOS (methods = WorkOS dashboard config; ceremony UI removed; relay verifies WorkOS JWKS; self-hosting = WorkOS account + API key). Keep registry/token/relay-seam sections.
- E2E smoke without real WorkOS: run apps/api against compose pg with `WORKOS_API_URL`/`WORKOS_JWKS_URL` pointed at a small stub script (reuse the test fake via a `scripts/fake-workos.ts` in apps/api, dev-only): `synara auth` full flow → status → host register → refresh path → logout. Report transcript.
- Full gate: fmt, lint, typecheck, `bun run test` in apps/api, contracts, shared, apps/server (full suite; the 2 known pre-existing failures documented).
- Push branch; update PR #42 title/body (WorkOS architecture, note the pivot + what stayed); watch CI to green (brand check, all jobs; rerun known-flaky browser test if it's the only red).

Commit(s): `docs: spec update for workos identity`, `feat(api): fake workos dev stub` (if separate), final push.

---

## Notes for implementers

- The old plan file `2026-08-03-account-api.md` stays as history; do not follow it.
- Real-WorkOS verification (with Dylan's actual WorkOS account) is deliberately out of scope — stub-verified; a manual checklist goes in the README.
- If `authorize/device` turns out to accept public `client_id` without API key in practice, KEEP the proxy anyway (it future-proofs rate limiting and hides tenancy), but note it.
