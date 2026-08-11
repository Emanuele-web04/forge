# Synara Account Backend (V1) — Design

Status: implemented
Date: 2026-08-03 (identity section revised 2026-08-05; rewritten 2026-08-10
for in-app OTP auth, the identity adapter seam, and maintainer feedback;
simplified 2026-08-11: CLI device grant and the in-app email-verification
challenge flow removed, Apple SSO added)
Branch base: `feat/remote-hosts` (implementation on a new worktree branch)

## Pivot notes

This design was written and built against a self-hosted auth library, which
owned users, passwords, sessions, signing keys, and a set of ceremony pages
this service rendered itself. Two revisions later, the shape is different in
two ways worth naming up front:

1. **Identity swapped to WorkOS AuthKit** (2026-08-05), cutting maintenance:
   no local key material, password hashing, or email delivery to own.
2. **Auth moved in-app and passwords were removed** (2026-08-08 → 09). The
   earlier claim that "WorkOS hosts every sign-in page" is dead: sign-in is a
   6-digit email code entered in the app, and only the SSO browser hop leaves
   it. Following maintainer review, the domain no longer touches WorkOS
   directly at all — it talks to internal adapter interfaces, with WorkOS as
   the default implementation and an offline dev provider as the second.

The host registry, host tokens, the relay seam, and the non-goals are
unchanged throughout. The sections below describe what is built.

## Purpose

A self-hostable account service so one Synara account owns a directory of all
the user's environments (MacBook, Mac Studio, VPS, …). Any signed-in device
can list every linked host and connect to it directly (LAN/Tailscale/public
URL). This is the foundation the future relay consumes; the relay itself is
out of scope.

The combined-sidebar/chats UX across hosts is enabled by this directory but
the UI work is a later phase. Chat/thread content never leaves the hosts.

## Trust model and scope

The account service is a **control plane and directory, nothing more**. It
answers "who are you", "which workspace are you acting in", and "which
environments does that workspace own, and where might they be reachable".

It must never store:

- chat or thread content, prompts, diffs, or any session data;
- provider API keys or coding-agent credentials;
- passwords (there is no password auth at all);
- plaintext host tokens (hashed at rest, shown once);
- anything a host serves — the service knows _that_ a host exists and where
  it claims to be, never what is on it.

**The service is optional.** Local, LAN, and Tailscale use works with no
account at all: a fresh clone has account features disabled, the CLI is inert
until `SYNARA_ACCOUNT_URL` is set, and the in-app sign-in only talks to a
service after the user clicks the button. Accounts buy a cross-device
directory, not admission to the product.

**Presence is historical, never live.** `lastSeenAt` records when a host last
interacted with the service (registration, self-update) and is presented as
exactly that — "last seen". It must never be rendered as online/offline: the
service holds no persistent connections and cannot know. The richer split a
relay makes possible — `relayConnected`, `directReachability`, a
`connectionState` the client owns — is named here so the fields have a home
when the relay lands, and is explicitly out of scope for V1.

## Architecture

One workspace app: **`apps/api`** — a single Railway-deployable service.

- **Hono** HTTP server (Node/Bun). Serves Synara routes at `/api/v1/*` and
  nothing else: no mounted auth pages and no static assets.
- **Identity behind an adapter seam** (next section). WorkOS AuthKit is the
  default provider; the service stores no users, passwords, sessions, or
  signing keys, and holds one server-side secret (the provider API key) for
  the calls that require it.
- **Drizzle ORM** on Postgres 18 via node-postgres. Production: PlanetScale
  Postgres (wire-compatible, standard driver). Local: docker-compose
  `postgres:18`.
- **No auth ceremony UI in this service.** Email-code sign-in happens in the
  app's own dialog; SSO finishes on the provider's hosted page in the system
  browser. Non-API paths answer with a one-line pointer rather than a 404
  that reads like an outage.

## The identity adapter seam

Maintainer feedback, adopted verbatim as the structuring rule: _Synara's
domain should not directly depend on WorkOS or BetterAuth._ The routes and
everything downstream depend on four internal interfaces
(`apps/api/src/identity/interfaces.ts`) and their classified failure
vocabulary (`invalid_verification_code`, `sso_required`,
`email_verification_required`, `verification_expired`, …). Provider wire
shapes, refusal spellings, and error classes stop at the implementation
modules.

- **`AccountIdentityVerifier`** — verifies an access token to
  `{userId, sessionId, orgId?}`; user lookup; and every authentication grant:
  OTP send/redeem, the PKCE authorize URL and code exchange, and token
  refresh (`refreshTokens`). Every leg of every flow goes through the seam —
  the identity vendor is invisible on the client wire.
- **`EnvironmentGrantIssuer`** — decides which environment scope a verified
  token may act inside: today, the organization membership check plus lazy
  personal-org provisioning. The name is for what it grows into (see Token
  model): when short-lived environment grants land, issuance moves here and
  today's resolution remains the authorization backbone.
- **`DeviceCredentialStore`** — mints, verifies, and revokes the long-lived
  credentials machines hold (the `synhost_` host tokens; hashed at rest, one
  active per host, rotated on re-link). Future device-bound
  proof-of-possession credentials slot in here.
- **`EnvironmentRegistry`** — the hosts directory: list, register (upsert by
  `(org, environmentId)`), self-update, owner- and self-removal. Speaks
  contract types; callers never touch storage rows.

Implementations, selected in exactly one place (`src/identity/index.ts`):

- **WorkOS** (`src/identity/workos.ts`) — the default, and the only module
  besides config plumbing where "WorkOS" appears. Backs the verifier and the
  grant issuer; the credential store and registry are database-owned and
  provider-independent.
- **Dev provider** (`src/identity/devProvider.ts`) — `IDENTITY_PROVIDER=dev`
  runs the test suite's in-process identity double behind the same WorkOS
  adapter production uses, giving contributors a fully offline account stack:
  any email signs in, the OTP code is printed to stdout (the one deliberate,
  gated exception to the no-leak rules), and the SSO authorize page
  self-approves as the dev user, 302ing straight back to the loopback
  listener. **Hard safety gate:** it refuses to start — process
  exit with an explanatory message — when `NODE_ENV=production` or while
  `WORKOS_API_KEY` is set, checked both in config loading and again inside
  the provider factory so a hand-built config cannot bypass it.
- **Future slots** — a generic OIDC implementation, or BetterAuth for
  self-hosters who want identity fully in-house, implement the same two
  interfaces. Nothing outside `src/identity/` changes.

The no-leak rules travel with the seam and remain binding: submitted codes
and pending tokens never appear in logs, error messages, thrown causes, or
response bodies beyond the documented challenge fields; credential-path
helpers never echo upstream bodies; validation failures use hand-worded
messages because the schema decoder quotes the offending value. Unclassified
provider refusals log only the HTTP status plus allowlisted labels — the
provider's free-form `code`/`error` strings never travel verbatim.

One deliberate, documented exemption: the client-side credential file. The
session tokens (access/refresh) and the host token ARE persisted on disk, in
plaintext, at `<synara home>/account-credentials.json`, mode `0600`, written
atomically. That is the accepted V1 threat model — an attacker who can read
the owner's home directory already owns the machine — and it is a storage
decision, not a hole in the no-leak rules above, which govern logs, error
paths, and response bodies. There is no OS-keychain storage in V1; step 10's
device-bound grants are the planned upgrade, not a keychain.

## Auth methods

Identity is the provider's; the set of enabled sign-in methods is a property
of the operator's provider application (dashboard toggles under WorkOS), not
of this service. What Synara ships is two ways in — and sign-in is app-only:
the CLI never signs in itself, it links the host using the app's session.

- **Email OTP (WorkOS Magic Auth) — fully in-app.** The app asks
  `POST /api/v1/auth/otp/send` to email a 6-digit code, then redeems it at
  `POST /api/v1/auth/otp/authenticate`. Redemption is sign-in AND sign-up:
  the provider provisions the user on first successful redemption, so there
  is no separate registration flow and the send route answers an identical
  202 for known and unknown addresses (no account-existence oracle). The
  proxy exists because the grant is confidential-client — it requires the
  client secret, which a public client cannot hold.
- **SSO (Google/Apple/GitHub) — authorization code + PKCE.** "Continue with
  Google/Apple/GitHub" runs the authorization-code grant with PKCE (S256)
  and a loopback redirect: the Synara server starts a one-shot listener on
  `127.0.0.1` (ephemeral port, single-use, hard timeout), asks the account
  service for the provider's authorize URL (`POST /api/v1/auth/authorize` —
  carries the provider, the loopback `redirect_uri`, the S256 challenge, and
  a random `state`), opens it in the system browser, validates `state` on
  the callback, and exchanges the code at `POST /api/v1/auth/authorize/token`
  with the PKCE verifier — proxied like every other grant, so the identity
  vendor stays off the client wire. The verifier and the authorization code
  are credentials with the full no-leak rules. **Required WorkOS dashboard
  configuration:** the loopback redirect URI must be registered on the
  AuthKit application — add `http://127.0.0.1:*/callback` (wildcard-port
  loopback redirects are allowed in all WorkOS environments); Sign in with
  Apple additionally needs the Apple Developer Services ID and key
  configured on the WorkOS side. All paths converge on the same
  `establishSession`.
- **No password auth.** The V1.1 password routes were removed with the OTP
  cutover; nothing accepts or stores a password.
- **No CLI device grant.** The RFC 8628 device flow (and its proxied polling
  leg) was removed in the 2026-08-11 simplification: sign-in is app-only,
  and `synara auth` links the host from the app's stored session.

**Email verification — a classified dead-end, not a flow.** Redeeming an OTP
implicitly proves address ownership, so the provider's
`email_verification_required` challenge should never fire on this path. If a
provider answers it anyway it is classified and surfaced as a terse 403
telling the user to sign in with an emailed code instead — the emailed-code
sign-in is itself the verification path. The previous in-app completion flow
(`/auth/verify-email`, `/auth/resend-verification`, the challenge step in
the dialog) was removed in the 2026-08-11 simplification.

Rate limits are per-route budgets, deliberately separate so exhausting one
cannot lock a user out of another: OTP send 2/min, OTP redemption and PKCE
code exchange 5/min, authorize-URL requests 10/min; all per client IP, per
process.

### Token verification

Access tokens are provider-issued JWTs, verified statelessly against the
provider's JWKS. Under WorkOS the issuer and JWKS URL are discovered from the
OIDC metadata document (WorkOS scopes `iss` to the _environment's_ client id,
so any hand-derived issuer is wrong for non-default applications);
`WORKOS_ISSUER`/`WORKOS_JWKS_URL` exist as overrides for custom auth domains
and stand-ins. A token must carry `sub`, `sid`, and a `client_id` matching
this application — the last check is what stops a sibling application's
token, valid against the same shared JWKS, from being accepted. Verification
being stateless means a session revoked at the provider stays valid for the
short token lifetime; revocation takes effect where the client refreshes.

## Token model

**Bearer tokens, today.** Three kinds:

- _Access token_ — short-lived (~5 min) provider JWT; authenticates
  user-level calls.
- _Refresh token_ — single-use, rotated on redemption, redeemed through
  `POST /api/v1/auth/refresh` (proxied; the client never talks to the
  provider). A 401 from that route proves the token dead; a 5xx or network
  failure must not burn the session — the service maps provider faults and
  terminal refusals to exactly that split.

- _Host token_ — the machine credential: hashed at rest, shown once, one
  active per host, rotated on re-link, revocable independently of any user
  session. An expired user session must not stop a running server from
  advertising itself.

**The named upgrade seam.** `establishSession` in
`apps/server/src/accountSession.ts` is the single choke point every sign-in
path (OTP, SSO, verify-email) already flows through: it scopes the token to a
workspace and persists the credential pair. Step 10 of the maintainer's
sequence — short-lived environment grants bound to a device credential
(proof-of-possession) — slots in there and in `EnvironmentGrantIssuer`
without touching the sign-in flows: `establishSession` exchanges the
provider session for an environment grant instead of storing the raw pair,
the issuer mints and validates those grants server-side, and hosts verify
grants instead of long-lived bearers. Until then, bearer stays, and the
seam's existence is the design commitment.

## Flows

**Sign-in (app):** email → `sendOtp` → six-box code entry → `authenticateOtp`
→ `establishSession` (workspace scoping + credential persistence) →
onboarding if no profile. The SSO buttons take the PKCE authorize flow
through the browser and converge on the same `establishSession`.

**Grant timeouts, two tiers:** cheap/idempotent provider calls (discovery,
`/me`, lookups) get a short per-attempt deadline (15s); GRANT-consuming
calls (OTP authenticate, PKCE code exchange, refresh) get 45s, and the
shared client's corresponding requests 60s — a grant spends a single-use
credential, so no client may abort before the layer beneath it has. When a
grant still fails transiently, the server re-checks persisted status before
surfacing anything: a sign-in that landed is reported as signed-in, and only
a genuinely unpersisted failure surfaces — as a retryable "provider was
slow" answer, never a flat "unavailable" for an operation that may have
succeeded.

**The CLI (`synara auth`):** links the host, nothing more. It reads the
app's stored session from the shared credentials file and registers this
machine; with no session it points the user at the app's sign-in. The
refresh leg stays proxied (`POST /auth/refresh`); which identity vendor sits
behind the service is invisible on the wire, which is what makes a
self-hosted or generic-OIDC backend a drop-in.

**Workspace scoping:** freshly minted sign-in tokens carry no organization
claim, so
the first authorized call answers `403 organization_required` with the
caller's organizations (provisioning a personal one if none exists); the
client refreshes with `organization_id` and retries. The same 403 answers a
token naming a workspace the caller has left — revoked membership takes
effect without anything being purged.

**Host linking:** after auth, the Synara server calls `POST /api/v1/hosts`
(access token) with its environment ID, name, platform, kind
(`local` | `ssh-managed`), and self-reported endpoints. The response includes
the one-time host token, stored in the Synara home dir (0600). Re-linking the
same environment updates the record and rotates the token.

## The organization model — why it stays

Ownership is keyed on the **organization**, never the user, and every user
gets a personal organization provisioned lazily on first use. This survives
maintainer review deliberately:

- **Personal orgs are invisible scaffolding.** The user sees "workspace" —
  onboarding names it, the sidebar shows it — never an "organization" concept
  to manage. There is no org switcher, no member list, no admin surface.
- **Org-keyed ownership is what makes team sharing a future feature instead
  of a future migration.** A team later is the same organization with more
  members: an invite, not a re-keying of every host row. The alternative
  (user-keyed rows now, migrate when teams land) buys nothing today and costs
  a data migration precisely when the product is trying to ship sharing.
- **Roles and multi-user semantics remain explicitly out of scope.** V1 has
  no roles, no invitations, no member management; two members of one org
  sharing hosts works (and is tested) but is not yet surfaced as a feature.

Consequences worth naming: `hosts.owner_org_id` is the only authorization
key; `hosts.registered_by_user_id` is audit-only and never consulted for
access; the unique index is `(owner_org_id, environment_id)` so one machine
can be linked from two workspaces; membership lists are cached per process
for 60 seconds.

## Data model (Drizzle)

There are **no identity tables**. The provider owns users, sessions,
credentials, and signing keys. Every provider id stored here is opaque with
no foreign key behind it; a user deleted at the provider leaves orphaned rows
until webhook cleanup exists (future work).

- `hosts`: `id` uuid pk · `ownerOrgId` text · `registeredByUserId` text
  (audit only) · `environmentId` text (unique per org) · `name` · `platform`
  (`darwin`|`linux`|`windows`) · `kind` (`local`|`ssh-managed`) · `endpoints`
  jsonb `[{url, transport: 'lan'|'tailscale'|'public'}]` · `appVersion` ·
  `createdAt` · `lastSeenAt`.
- `host_tokens`: `id` · `hostId` fk cascade · `tokenHash` · `createdAt` ·
  `lastUsedAt` · `revokedAt` nullable.
- `profiles`: `userId` (provider user id, pk) · `handle` (unique, immutable
  in V1) · `displayName` · `avatarColor` · timestamps. A row existing is what
  "onboarding completed" means; there is deliberately no separate flag.

Request/response contracts live in `packages/contracts` (schema-only).

## API surface (`/api/v1`)

| Endpoint                      | Auth           | Purpose                                                                       |
| ----------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `GET /me`                     | access token   | Identity, workspace, and profile (or null pre-onboarding)                     |
| `PUT /profile`                | access token   | Upsert profile; handle immutable; answers the `/me` body                      |
| `PATCH /organization`         | access token   | Rename the workspace; answers the `/me` body                                  |
| `GET /hosts`                  | access token   | List the workspace's hosts with endpoints + lastSeenAt                        |
| `POST /hosts`                 | access token   | Register this machine; returns record + one-time host token                   |
| `PATCH /hosts/:id`            | host token     | Update name/endpoints/version; bumps lastSeenAt                               |
| `DELETE /hosts/:id`           | access or host | Unlink (owner removal or self-removal)                                        |
| `POST /auth/otp/send`         | none (2/min)   | Email a 6-digit sign-in code; 202 regardless of account                       |
| `POST /auth/otp/authenticate` | none (5/min)   | Redeem the code for a token pair; signs up on first use                       |
| `POST /auth/authorize`        | none (10/min)  | Build the PKCE authorize URL (SSO); loopback redirects only                   |
| `POST /auth/authorize/token`  | none (5/min)   | Exchange the authorization code + PKCE verifier for a token pair              |
| `POST /auth/refresh`          | none (10/min)  | Redeem a refresh token for a rotated, optionally workspace-scoped pair        |
| `GET /instance`               | none           | Version + what the verifier publishes (auth mode, client id, provider origin) |

Errors: typed codes in contracts with correct HTTP status; clients branch on
code. Upstream provider failures answer 502 with an opaque message and a
server-side log. Sessions listing/revocation stays deferred to the provider's
dashboard; sign-out is local (drops the session, keeps the host
registration).

`/instance` is wire-stable: `authMode: "workos"` stays, and `clientId` /
`workosApiUrl` are **deprecated-but-present** — Synara's own clients do not
consume them (every provider call is proxied), but the fields keep their
values and their meaning for wire stability. `authMode` may grow into a
literal union as more provider families ship.

## Client integration (`apps/server`, `apps/web`)

- `synara auth` / `synara auth logout` / `synara status` — host linking
  (using the app's signed-in session), teardown, and status; all inert
  without `SYNARA_ACCOUNT_URL`. The CLI performs no sign-in of its own.
- **Credentials file (v3)** at `<synara home>/account-credentials.json`, mode
  `0600`, written atomically; session fields and host registration are
  independently optional, so an expired session leaves the host linked.
- **Transparent refresh** — every user-scoped call retries once on a 401,
  persisting the rotated pair before the retry.
- **In-app account** — `accountSession.ts` owns sign-in state server-side;
  the account RPC group (status, sendOtp, authenticateOtp, beginSso,
  completeSso, cancelSso, updateProfile, signOut, openVerificationUrl — see
  `apps/server/src/wsAccountRpc.ts`, all owner-only) rides the existing
  WebSocket; the web app renders the sign-in dialog (SSO buttons, email →
  code boxes), onboarding (handle, display name, avatar color), and the
  sidebar account menu. All sign-in paths converge on `establishSession`.

## Local dev, deployment

- `apps/api/docker-compose.yml`: `postgres:18`. `.env.example` documents all
  variables; no provider OAuth pairs, no SMTP.
- **Offline dev:** `IDENTITY_PROVIDER=dev` (see the seam section) is the
  recommended path — codes on stdout, no tenancy, production-gated. The
  standalone `scripts/fake-workos.ts` stub remains for exercising the real
  WorkOS env wiring end to end.
- Migrations: Drizzle Kit generated SQL, committed; applied on boot
  (single-instance assumption acceptable for V1).
- Deploy: one Railway service, no build step (Bun runs TypeScript directly);
  `DATABASE_URL` → PlanetScale Postgres over TLS. Environment unchanged means
  the WorkOS provider with identical behavior — the seam refactor is invisible
  to a deployed instance.
- **Deploy ordering: api before clients.** The proxied auth routes exist
  only on the new api, and a new client calls them unconditionally — there
  is no capability negotiation in V1 (clients are same-repo, the risk window
  is one rolling deploy). Against an older api the client's call 404s and is
  rewritten to an "account service is out of date" answer (see
  `withProxySkewError` in `packages/shared/src/account.ts`) rather than
  hanging. A real capability/version gate is deliberate future work.

## Testing

- Vitest via `bun run test` (never `bun test`), against real pg18 from
  compose. The provider is never called: `src/testing/fakeWorkos.ts` is an
  in-process double serving JWKS, OIDC discovery, the OTP/PKCE/refresh
  grants, Magic Auth creation, and the organization APIs, with single-use
  refresh tokens and deterministic 6-digit codes.
- Route tests cover host CRUD and cross-org isolation, profiles and handle
  immutability, the full OTP matrix (happy paths, wrong/expired codes, resend
  invalidation, no-oracle sends, rate-budget separation, `sso_required`), the
  PKCE authorize/exchange flow, and no-leak assertions that sentinel codes
  appear in no response body and no captured console output.
- The dev provider has its own suite: the safety gate (config and factory
  level) and a full offline sign-in loop driven by the stdout code.
- Final gate: `bun fmt`, `bun lint`, `bun typecheck` full pass. Real-provider
  verification stays a manual checklist in `apps/api/README.md`.

## Non-goals (V1)

Mirroring the maintainer's deferral list: **team sharing** (org-keyed rows
make it possible; nothing surfaces it), **organizations as UX** (personal
orgs stay invisible), **roles and member management**, **the relay** (and
relay grants — no `relay_grants` table), **a web coding surface**,
**credential transfer** of any kind (provider keys and agent credentials
never leave a host), and **DB/chat/thread sync**. Also: presence state or
heartbeats (lastSeenAt stays historical), in-service session listing and
revocation, iOS work, and any self-hosted sign-in ceremony UI.
