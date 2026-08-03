# Synara Account Backend (V1) — Design

Status: approved design, pre-implementation
Date: 2026-08-03
Branch base: `feat/remote-hosts` (implementation on a new worktree branch)

## Purpose

A self-hostable account service so one Synara account owns a directory of all the
user's environments (MacBook, Mac Studio, VPS, …). Any signed-in device can list
every linked host and connect to it directly (LAN/Tailscale/public URL). This is
the foundation the future relay consumes; the relay itself is out of scope.

The combined-sidebar/chats UX across hosts is enabled by this directory but the
UI work is a later phase. Chat/thread content never leaves the hosts.

## Architecture

One new workspace app: **`apps/api`** — a single Railway-deployable service.

- **Hono** HTTP server (Node/Bun). Mounts BetterAuth at `/api/auth/*`, Synara
  routes at `/api/v1/*`, and serves the static auth-ceremony UI for other paths.
- **BetterAuth** for accounts. Plugins: `jwt` (publishes `/api/auth/jwks` so the
  future relay can verify tokens offline) and `deviceAuthorization` (headless
  `synara auth` flow).
- **Drizzle ORM** on Postgres 18 via node-postgres. Production: PlanetScale
  Postgres (wire-compatible, standard driver). Local: docker-compose `postgres:18`.
- **Auth UI**: Vite + React + Tailwind, built to static assets served same-origin
  by Hono (no CORS anywhere). Ceremony pages only — sign-in, sign-up, device
  approval, reset-password, verify-email, OAuth callback/close, errors. No
  account dashboard in the browser; account management lives in the clients.

### Separation from the relay (future)

The API is pure request/response: no WebSockets, no heartbeats, no presence
state, no long-lived connections. The relay will be a **separate statically
hosted service** owning all persistent sockets (hosts dial out over WSS; relay
splices client↔host and forwards opaque frames). Coupling is thin by design:
the relay verifies client JWTs against the API's JWKS (cached public keys) and
checks relay grants the API mints. V1 ships the JWKS endpoint; grants and the
relay come later with no schema migration pressure (a `relay_grants` table is
anticipated but deliberately not created).

Presence in V1 is client-determined: clients try each host's stored endpoints
directly (cheapest transport wins: loopback → LAN → SSH → relay-later). The API
records `lastSeenAt` only on real interactions.

### Self-hosting model (off by default)

The maintainer hosts nothing. A fresh clone has account features disabled;
clients enable them only when `SYNARA_ACCOUNT_URL` is set. Each instance
operator brings their own OAuth app registrations and secrets via env config.
No secrets in the repo.

## Auth Methods

Email/password + GitHub, Google, Apple, Microsoft — all via BetterAuth, all in V1.

- Each social provider activates only when its `*_CLIENT_ID`/`*_CLIENT_SECRET`
  env vars are present. `GET /api/v1/instance` reports enabled methods so
  clients render the right buttons.
- Email/password uses BetterAuth's native hashing (scrypt). Password reset and
  email verification require optional SMTP/Resend config; absent, email/password
  still works and the instance endpoint reports reset as unavailable.
- Account linking across providers with the same email: BetterAuth trusted-
  provider linking enabled.
- Optional sign-in restriction: `ACCOUNT_ALLOWED_GITHUB_LOGINS` (and email
  allowlist equivalent) gates sign-ups on personal instances; unset = open.
- Apple note: requires a paid Apple Developer account, and App Store policy
  requires Sign in with Apple once the iOS app ships other social logins.

## Flows

**Desktop (headed, Electron):**
- Email/password: form rendered fully in the desktop UI, calling BetterAuth
  endpoints directly against `SYNARA_ACCOUNT_URL`. No browser.
- Social: system browser opens the provider flow; the web callback page
  redirects to a **`synara://` deep link** (`synara-dev://` in dev builds) with
  a one-time code the app exchanges for its device token; page shows a manual
  "return to app" fallback link.

**Headless (`synara auth` on a VPS/SSH box):** OAuth-style device flow (Claude
Code UX): CLI prints approval URL + code, user approves in any browser (phone
works), CLI polls and receives the device token automatically. No code pasting.

**iOS (later):** same deep-link pattern as desktop; no loopback needed. V1
builds nothing iOS-specific.

*V1 implementation boundary:* the desktop flows above are the agreed design,
but V1 implements only the server side of them — the ceremony pages, the
callback page's `synara://` redirect with one-time code, and the code-exchange
endpoint. The in-app desktop form and deep-link handling land with the desktop
UI phase; until then, desktop users authenticate via `synara auth` (the CLI
ships inside the desktop bundle).

**Tokens:**
- *Device token* — long-lived BetterAuth session per signed-in device,
  revocable individually. Authenticates user-level calls.
- *Host token* — minted when a machine registers as an environment; hashed at
  rest (SHA-256), shown once, one active token per host, rotated on re-link,
  independently revocable. Authenticates that machine's own record updates.

**Host linking:** after auth on a machine, the Synara server calls
`POST /api/v1/hosts` (device token) with its environment ID (reusing the
server's existing environment identity from feat/remote-hosts), name, platform,
kind (`local` | `ssh-managed`), and self-reported endpoints. Response includes
the one-time host token, stored in the Synara home dir (0600).

## Data Model (Drizzle)

BetterAuth-owned tables (generated by its CLI, committed): `user`, `session`,
`account`, `verification`, plus device-authorization and JWKS tables.

Synara tables:

- `hosts`: `id` uuid pk · `userId` fk→user cascade · `environmentId` text,
  unique per user · `name` · `platform` (`darwin`|`linux`|`windows`) · `kind`
  (`local`|`ssh-managed`) · `endpoints` jsonb `[{url, transport:
  'lan'|'tailscale'|'public'}]` · `appVersion` · `createdAt` · `lastSeenAt`.
- `host_tokens`: `id` · `hostId` fk cascade · `tokenHash` · `createdAt` ·
  `lastUsedAt` · `revokedAt` nullable.

Request/response contracts live in `packages/contracts` (schema-only).

## API Surface (`/api/v1`)

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /me` | device | Signed-in identity (login, name, avatar, email) |
| `GET /hosts` | device | List linked hosts with endpoints + lastSeenAt |
| `POST /hosts` | device | Register this machine; returns record + one-time host token |
| `PATCH /hosts/:id` | host | Update name/endpoints/version; bumps lastSeenAt |
| `DELETE /hosts/:id` | device or host | Unlink (self-removal or owner removal) |
| `GET /sessions` | device | List device sessions |
| `DELETE /sessions/:id` | device | Revoke a device |
| `GET /instance` | none | Version, enabled auth methods, signup mode, email availability |

Plus BetterAuth's mounted `/api/auth/*` (sign-in/up, social, device flow,
polling) and `/api/auth/jwks`.

Errors: typed codes in contracts (`host_not_found`, `token_revoked`,
`signup_restricted`, …) with correct HTTP status; clients branch on code.
Rate limiting on pre-auth surfaces (device-code endpoints; BetterAuth built-in).

## Client Integration (`apps/server`)

- `synara auth` — device flow; stores device token; `synara auth logout`
  revokes and deletes it.
- `synara status` — identity + this machine's host record + all linked hosts;
  degrades gracefully when `SYNARA_ACCOUNT_URL` is unset.
- Self-registration after auth; server startup fires a single best-effort
  `PATCH` (refresh endpoints, bump lastSeenAt) when a host token exists — one
  request, never a loop.
- `SYNARA_ACCOUNT_URL` added to config + turbo `globalEnv`. Everything inert
  without it.
- Desktop UI account section (identity, host list, session revocation) is a
  later UI phase; endpoints above are its complete contract. Since desktop
  bundles the server, `synara auth`/`status` work everywhere in V1.

## Local Dev, Deployment

- `apps/api/docker-compose.yml`: `postgres:18`, volume, healthcheck.
- `.env.example` documents all variables: `DATABASE_URL`, `BETTER_AUTH_SECRET`,
  `ACCOUNT_BASE_URL`, per-provider OAuth pairs, optional SMTP/Resend, optional
  allowlist.
- Dev: Vite dev-server for the UI proxying `/api` to Hono; wired into the
  existing dev-runner.
- Migrations: Drizzle Kit generated SQL, committed; API applies pending
  migrations on boot (single-instance assumption acceptable for V1).
- Deploy: one Railway service (build UI + server, start Hono); `DATABASE_URL`
  → PlanetScale Postgres over TLS; Railway URL becomes `ACCOUNT_BASE_URL` and
  the OAuth callback origin.

## Testing

- Vitest via `bun run test` (never `bun test`), against real pg18 from compose:
  host CRUD, authz rules (device vs host token; strict cross-user isolation),
  token hashing/revocation/rotation, allowlist hook, instance reporting.
- Auth flows over HTTP: email/password sign-up/in; device flow end-to-end
  (request code → approve with session → poll → token).
- Social providers: config/callback wiring tested; real IdPs verified manually
  once OAuth apps exist (no live-IdP integration tests).
- CLI commands tested against a mocked account API.
- Final gate: `bun fmt`, `bun lint`, `bun typecheck` full pass.

**End-to-end verification:** compose up → email/password sign-up → `synara auth`
device flow from a second shell → `synara status` shows account → host
self-registers → appears in `GET /hosts` → revocation works.

## Non-Goals (V1)

Relay service and relay grants; chat/thread/profile-stats sync; iOS work;
desktop account UI; presence state or heartbeats; any persistent connection to
the API.
