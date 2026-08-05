# Synara Account Backend (V1) — Design

Status: implemented
Date: 2026-08-03 (identity section revised 2026-08-05)
Branch base: `feat/remote-hosts` (implementation on a new worktree branch)

## Pivot note

This design was written and built against a self-hosted auth library, which
owned users, passwords, sessions, signing keys, and a set of ceremony pages
this service rendered itself. On 2026-08-05, post-V1, identity was swapped to
**WorkOS AuthKit** to cut maintenance: sign-in methods become dashboard
toggles instead of per-provider env pairs, the ceremony UI and its build step
disappear entirely, and there is no local key material, password hashing, or
email delivery to own. The host registry, host tokens, the relay seam, and the
non-goals below are unchanged by the swap — only the identity half moved. The
sections that follow describe the WorkOS design as built.

## Purpose

A self-hostable account service so one Synara account owns a directory of all the
user's environments (MacBook, Mac Studio, VPS, …). Any signed-in device can list
every linked host and connect to it directly (LAN/Tailscale/public URL). This is
the foundation the future relay consumes; the relay itself is out of scope.

The combined-sidebar/chats UX across hosts is enabled by this directory but the
UI work is a later phase. Chat/thread content never leaves the hosts.

## Architecture

One new workspace app: **`apps/api`** — a single Railway-deployable service.

- **Hono** HTTP server (Node/Bun). Serves Synara routes at `/api/v1/*` and
  nothing else: there are no mounted auth routes and no static assets.
- **WorkOS AuthKit** for identity. This service stores no users, passwords,
  sessions, or signing keys — WorkOS owns all of it. The service verifies
  WorkOS-issued JWTs and holds one server-side secret (the WorkOS API key) for
  the single call that requires it.
- **Drizzle ORM** on Postgres 18 via node-postgres. Production: PlanetScale
  Postgres (wire-compatible, standard driver). Local: docker-compose `postgres:18`.
- **No auth UI.** WorkOS hosts every sign-in page, so there is no ceremony UI to
  build, serve, or keep same-origin — and correspondingly no Vite/React/Tailwind
  build in this app. Non-API paths answer with a one-line pointer rather than a
  404 that reads like an outage. Account management lives in the clients.

### Separation from the relay (future)

The API is pure request/response: no WebSockets, no heartbeats, no presence
state, no long-lived connections. The relay will be a **separate statically
hosted service** owning all persistent sockets (hosts dial out over WSS; relay
splices client↔host and forwards opaque frames). Coupling is thin by design:
the relay verifies client JWTs against **WorkOS's** JWKS (cached public keys,
fetched from WorkOS directly at
`https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}`) and checks relay grants
the API mints. This is strictly less coupling than before the swap — the relay
no longer depends on this service publishing a JWKS at all, so the two share
only the WorkOS client id. Grants and the relay come later with no schema
migration pressure (a `relay_grants` table is anticipated but deliberately not
created).

Presence in V1 is client-determined: clients try each host's stored endpoints
directly (cheapest transport wins: loopback → LAN → SSH → relay-later). The API
records `lastSeenAt` only on real interactions.

### Self-hosting model (off by default)

The maintainer hosts nothing. A fresh clone has account features disabled;
clients enable them only when `SYNARA_ACCOUNT_URL` is set. No secrets in the
repo.

Standing up an instance needs a **free WorkOS account** and exactly two
environment variables — `WORKOS_API_KEY` and `WORKOS_CLIENT_ID` — plus a
`DATABASE_URL` and `ACCOUNT_BASE_URL`. There are no per-provider OAuth app
registrations to create: enabling Google or GitHub sign-in is a toggle in the
WorkOS dashboard, not a pair of secrets in the operator's environment. Three
further variables (`WORKOS_API_URL`, `WORKOS_JWKS_URL`, `WORKOS_ISSUER`) exist
only to point the service at a stand-in and are unset in production.

## Auth Methods

Identity is **WorkOS AuthKit**, and the set of enabled sign-in methods is a
property of the operator's WorkOS application, not of this service.

- **Sign-in methods are dashboard toggles.** Email/password, Google, GitHub,
  Microsoft and the rest are enabled per-application in the WorkOS dashboard.
  This service neither knows nor reports which are on, so `GET /api/v1/instance`
  publishes the WorkOS client id and API origin instead of a method list, and
  clients hand off to WorkOS rather than rendering per-provider buttons.
- **Password hashing, reset, verification, and email delivery are WorkOS's.**
  No scrypt, no SMTP or Resend configuration, no verification tables.
- **Account linking** across providers with the same email is WorkOS behaviour,
  configured in the dashboard.
- **The CLI device flow requires "CLI Auth" enabled** in the WorkOS dashboard
  under Authentication; the device authorization endpoint errors until it is.
- Restricting who may sign in is a WorkOS dashboard concern on personal
  instances; this service ships no allowlist of its own.
- Apple note is unchanged: it requires a paid Apple Developer account, and App
  Store policy requires Sign in with Apple once the iOS app ships other social
  logins. Under WorkOS this is still a dashboard toggle.

### Token verification

Access tokens are WorkOS-issued JWTs, verified statelessly against WorkOS's
JWKS at `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}` — fetched and
cached by the JWT library, refreshed on an unknown `kid`. Two consequences are
deliberate:

- The expected `iss` is configurable. WorkOS mints the API origin **with** a
  trailing slash, and swaps in a custom auth domain when one is configured, so
  `WORKOS_ISSUER` overrides the default rather than being a constant.
- Verification is stateless, so a session revoked at WorkOS stays valid here
  until the short access-token lifetime (~5 minutes) runs out. Revocation takes
  effect where the client refreshes: at WorkOS.

A token must carry both `sub` and `sid`; anything else is not a WorkOS access
token and is rejected rather than treated as authenticated.

## Flows

**Headless and desktop alike (`synara auth`):** the WorkOS **device
authorization grant** (Claude Code UX). The CLI prints WorkOS's approval URL
and user code, the user approves on any browser (a phone works), and the CLI
polls until WorkOS returns tokens. No code pasting, no loopback listener, and
nothing to render locally — the approval page is WorkOS's.

The one wrinkle is where each request goes. Starting the flow needs the WorkOS
API key, which a public client cannot be trusted with, so the CLI asks _this
service_ to start it (`POST /api/v1/auth/device`) and the service proxies to
WorkOS with its key. Everything after that — polling the token endpoint, and
later refreshing — goes from the CLI **straight to WorkOS**, which is why
`/instance` publishes the client id and WorkOS API origin. Keeping the proxy
for the first call also gives us a place to rate-limit a pre-auth surface and
keeps the operator's WorkOS tenancy out of the client.

**Desktop (headed, Electron) and iOS (later):** AuthKit's hosted pages, opened
in the system browser. The in-app account UI lands with the desktop UI phase;
until then desktop users authenticate via `synara auth`, which ships inside the
desktop bundle. The pre-swap design's ceremony pages, `synara://` deep-link
callback, and one-time code-exchange endpoint are **all dropped** — they existed
to bridge self-hosted auth pages back into the app, and WorkOS's hosted flow
needs no such bridge.

**Tokens:**

- _Access token_ — a short-lived (~5 minute) WorkOS JWT. Authenticates
  user-level calls; verified against WorkOS's JWKS.
- _Refresh token_ — issued alongside it, **single-use**: redeeming one returns
  a replacement pair. The client persists the rotated pair _before_ retrying the
  call, since a crash between redeeming and writing would otherwise strand the
  user with a spent token and no way to tell why. Only a 4xx from the token
  endpoint proves a refresh token is dead; a 5xx or a network failure says
  nothing about it and must not burn the session.
- _Host token_ — unchanged by the swap. Minted when a machine registers as an
  environment; hashed at rest (SHA-256), shown once, one active token per host,
  rotated on re-link, independently revocable. Authenticates that machine's own
  record updates, and its lifetime is independent of the user session — an
  expired session must not stop a running server from advertising itself.

**Host linking:** after auth on a machine, the Synara server calls
`POST /api/v1/hosts` (access token) with its environment ID (reusing the
server's existing environment identity from feat/remote-hosts), name, platform,
kind (`local` | `ssh-managed`), and self-reported endpoints. Response includes
the one-time host token, stored in the Synara home dir (0600).

## Data Model (Drizzle)

There are **no identity tables**. WorkOS owns users, sessions, credentials, and
signing keys, so the pre-swap `user`/`session`/`account`/`verification` tables
and the device-authorization and JWKS tables are all gone. The database holds
only the host registry.

Because there is no local `user` row, `hosts.userId` is an **opaque WorkOS user
id with no foreign key behind it**. Two consequences follow: cross-user
isolation is enforced in the query layer (every user-scoped read filters on the
verified `sub`) rather than by a constraint, and deleting a user at WorkOS does
not cascade here — a deleted account's host rows are orphaned until removed.

Synara tables:

- `hosts`: `id` uuid pk · `userId` text (WorkOS user id) · `environmentId` text,
  unique per user · `name` · `platform` (`darwin`|`linux`|`windows`) · `kind`
  (`local`|`ssh-managed`) · `endpoints` jsonb `[{url, transport:
'lan'|'tailscale'|'public'}]` · `appVersion` · `createdAt` · `lastSeenAt`.
- `host_tokens`: `id` · `hostId` fk cascade · `tokenHash` · `createdAt` ·
  `lastUsedAt` · `revokedAt` nullable.

Request/response contracts live in `packages/contracts` (schema-only).

## API Surface (`/api/v1`)

| Endpoint            | Auth           | Purpose                                                     |
| ------------------- | -------------- | ----------------------------------------------------------- |
| `GET /me`           | access token   | Signed-in identity (name, avatar, email), read from WorkOS  |
| `GET /hosts`        | access token   | List linked hosts with endpoints + lastSeenAt               |
| `POST /hosts`       | access token   | Register this machine; returns record + one-time host token |
| `PATCH /hosts/:id`  | host           | Update name/endpoints/version; bumps lastSeenAt             |
| `DELETE /hosts/:id` | access or host | Unlink (self-removal or owner removal)                      |
| `POST /auth/device` | none           | Start the CLI device flow; proxies to WorkOS with the key   |
| `GET /instance`     | none           | Version, auth mode, WorkOS client id and API origin         |

There are no mounted auth routes and no JWKS endpoint here — sign-in, social,
token exchange, and key publication all live at WorkOS.

**Session listing and revocation are deferred to the WorkOS dashboard.** The
pre-swap `GET /sessions` and `DELETE /sessions/:id` are dropped: sessions are
WorkOS's, and re-exposing them would mean proxying an API this service has no
opinion about. Sign-out is therefore local — `synara auth logout` tears down the
host registration and deletes the credentials file; the identity-provider
session expires on its own. A first-class sessions view can come back later as
a proxy if the clients need one.

Errors: typed codes in contracts (`host_not_found`, `token_revoked`, …) with
correct HTTP status; clients branch on code. Upstream WorkOS failures answer
`502` with an opaque message and a server-side log — a rejected API key, an
outage, and a mapping bug must not be distinguishable to the caller, but the
operator still needs to tell them apart. Rate limiting covers the one pre-auth
surface, `POST /auth/device`, per client IP.

## Client Integration (`apps/server`)

- `synara auth` — WorkOS device flow; stores the access/refresh pair.
  `synara auth logout` removes the host record and deletes the credentials file.
- `synara status` — identity + this machine's host record + all linked hosts;
  degrades gracefully when `SYNARA_ACCOUNT_URL` is unset.
- **Credentials file (v2)** at `<synara home>/account-credentials.json`, mode
  `0600`, written atomically: `accountUrl`, `workosClientId`, `workosApiUrl`,
  the `accessToken`/`refreshToken` pair, and the `hostToken`/`hostId` pair. The
  two halves are optional independently, so an expired session leaves the host
  registration intact and a later `synara auth` re-links this machine instead
  of stranding a phantom host. A pre-swap file (recognised by its `deviceToken`)
  is treated as absent: those tokens came from an endpoint that no longer
  exists, so there is nothing to migrate and re-authenticating is the only path.
- **Transparent refresh.** Every user-scoped CLI call runs through a helper that
  retries once on a 401, redeeming the refresh token and persisting the rotated
  pair before the retry. Renewal is driven by a rejected call rather than by
  reading `exp` off the JWT — one wasted round trip per expiry, in exchange for
  not parsing or trusting token internals client-side.
- Self-registration after auth; server startup fires a single best-effort
  `PATCH` (refresh endpoints, bump lastSeenAt) when a host token exists — one
  request, never a loop.
- `SYNARA_ACCOUNT_URL` added to config + turbo `globalEnv`. Everything inert
  without it.
- Desktop UI account section (identity, host list) is a later UI phase;
  endpoints above are its complete contract. Since desktop bundles the server,
  `synara auth`/`status` work everywhere in V1.

## Local Dev, Deployment

- `apps/api/docker-compose.yml`: `postgres:18`, volume, healthcheck.
- `.env.example` documents all variables: `DATABASE_URL`, `WORKOS_API_KEY`,
  `WORKOS_CLIENT_ID`, `ACCOUNT_BASE_URL`, `PORT`, and the three
  stand-in overrides. No provider pairs, no SMTP, no auth secret.
- Dev: `bun run --cwd apps/api dev` and nothing else — with no UI there is no
  Vite dev-server or proxy to wire up.
- **Working without a WorkOS account:** `apps/api/scripts/fake-workos.ts` runs
  the same in-process double the test suite uses as a standalone server, on a
  fixed port, auto-approving device authorizations on a timer. Pointing
  `WORKOS_API_URL`/`WORKOS_JWKS_URL` at it makes the whole `synara auth` → status
  → refresh → logout path runnable headlessly with no WorkOS tenancy.
- Migrations: Drizzle Kit generated SQL, committed; API applies pending
  migrations on boot (single-instance assumption acceptable for V1).
- Deploy: one Railway service, no build step (Bun runs the TypeScript directly);
  `DATABASE_URL` → PlanetScale Postgres over TLS; the Railway URL becomes
  `ACCOUNT_BASE_URL` and is added to the allowed redirect URIs in the WorkOS
  dashboard.

## Testing

- Vitest via `bun run test` (never `bun test`), against real pg18 from compose:
  host CRUD, authz rules (access token vs host token; strict cross-user
  isolation), token hashing/revocation/rotation, instance reporting.
- **WorkOS is never called.** `apps/api/src/testing/fakeWorkos.ts` is an
  in-process double that serves a JWKS from a freshly generated key pair, mints
  access tokens signed by it, and answers the user-lookup, device-authorization,
  and token endpoints (device and refresh grants, with single-use refresh
  tokens). That covers expiry, a wrong issuer, missing claims, and a deleted
  user without a network or a shared fixture.
- CLI and shared-client commands tested against a mocked account API, including
  refresh rotation and the rule that only a 4xx burns the session.
- Real-WorkOS verification against a live tenancy is deliberately out of scope
  and covered by a manual checklist in `apps/api/README.md`.
- Final gate: `bun fmt`, `bun lint`, `bun typecheck` full pass.

**End-to-end verification:** compose up → migrations → API pointed at the
fake-WorkOS dev stub → `synara auth` device flow (auto-approved) → credentials
v2 written `0600` → `synara status` shows account and host → forced refresh
rotation persists a new pair while keeping the host registration → `synara auth
logout` removes the host row and the file.

## Non-Goals (V1)

Relay service and relay grants (no `relay_grants` table); chat/thread/
profile-stats sync; iOS work; desktop account UI; presence state or heartbeats;
any persistent connection to the API. Added by the identity swap: in-service
session listing and revocation (WorkOS dashboard owns them), and any
self-hosted sign-in UI.
