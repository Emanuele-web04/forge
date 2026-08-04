# @synara/api

The Synara account service: BetterAuth at `/api/auth/*`, account/host routes under
`/api/v1`, and the auth ceremony UI on every other path.

It is a **self-hosting-first, opt-in** component. Synara works fully without it;
nothing in this app runs unless you deploy an instance and point a server at it.

## Off by default, and no secrets in this repo

- **No instance runs unless you start one.** There is no hosted default, no
  fallback URL, and no telemetry endpoint baked into the code.
- **The client is gated on `SYNARA_ACCOUNT_URL`.** `@synara/server` only talks to
  an account service when that variable (or `synara auth --account-url`) names
  one. Unset, `synara status` prints "account features are not configured" and
  the server never opens a socket to anything.
- **No credentials are committed.** Every secret is read from the environment at
  boot (see `src/config.ts`). `apps/api/.env` is gitignored; `.env.example`
  carries names and comments only, never values. Host and device tokens live on
  the operator's machine under `<synara home>/account-credentials.json` at mode
  `0600`, never in the repository.

## Quick start (local)

```sh
docker compose -f apps/api/docker-compose.yml up -d          # Postgres 18 on :5432
cp apps/api/.env.example apps/api/.env                       # then fill in the blanks
openssl rand -base64 32                                      # → BETTER_AUTH_SECRET
bun install
bun run --cwd apps/api dev                                   # http://localhost:8788
```

Migrations run automatically at boot (`runMigrations` in `src/index.ts`), so an
empty database is fine. To generate new SQL after a schema change, use
`bun run --cwd apps/api db:generate`; to apply without booting the server, use
`db:migrate`.

Then, from a Synara server checkout:

```sh
SYNARA_ACCOUNT_URL=http://localhost:8788 bun run --cwd apps/server src/index.ts auth
SYNARA_ACCOUNT_URL=http://localhost:8788 bun run --cwd apps/server src/index.ts status
```

## Environment variables

| Variable                          | Required | Default | Purpose                                                                               |
| --------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                    | yes      | —       | Postgres connection string for Drizzle and BetterAuth.                                |
| `BETTER_AUTH_SECRET`              | yes      | —       | Signs sessions and encrypts the stored JWKS. Generate with `openssl rand -base64 32`. |
| `ACCOUNT_BASE_URL`                | yes      | —       | Public origin of this instance. OAuth callback URLs are derived from it.              |
| `PORT`                            | no       | `8788`  | HTTP listen port.                                                                     |
| `GITHUB_CLIENT_ID` / `_SECRET`    | no       | —       | Enables GitHub sign-in when **both** are set.                                         |
| `GOOGLE_CLIENT_ID` / `_SECRET`    | no       | —       | Enables Google sign-in when both are set.                                             |
| `APPLE_CLIENT_ID` / `_SECRET`     | no       | —       | Enables Sign in with Apple when both are set. See the Apple note below.               |
| `MICROSOFT_CLIENT_ID` / `_SECRET` | no       | —       | Enables Microsoft (Entra ID) sign-in when both are set.                               |
| `RESEND_API_KEY`                  | no       | —       | Sends verification/reset email via Resend.                                            |
| `SMTP_URL`                        | no       | —       | SMTP fallback, used when Resend is not configured.                                    |
| `EMAIL_FROM`                      | no       | —       | From address for outgoing account email.                                              |
| `ACCOUNT_ALLOWED_SIGNUP_EMAILS`   | no       | —       | Comma-separated allowlist. Unset means anyone may sign up.                            |
| `TEST_DATABASE_URL`               | tests    | —       | Database the Vitest suites use. Without it they skip.                                 |

A missing required variable fails the boot with an explicit
`Missing required environment variables: …` rather than starting half-configured.

Email/password sign-in is always on. Each social provider activates only when
both halves of its pair are present, and `GET /api/v1/instance` reports the
resulting method set so the ceremony UI renders exactly the buttons that work.

**Run an allowlist on any instance you do not want strangers on.** Without
`ACCOUNT_ALLOWED_SIGNUP_EMAILS`, a reachable instance accepts open signups.

## Registering OAuth apps

For every provider, the redirect URI is
`${ACCOUNT_BASE_URL}/api/auth/callback/<provider>` — for example
`https://accounts.example.com/api/auth/callback/github`. Register the exact
origin you deploy to; a mismatch is the usual cause of a provider bouncing the
login back with an error.

- **GitHub** — Settings → Developer settings → OAuth Apps → New OAuth App.
  Authorization callback URL: `${ACCOUNT_BASE_URL}/api/auth/callback/github`.
  <https://docs.github.com/apps/oauth-apps/building-oauth-apps>
- **Google** — Google Cloud console → APIs & Services → Credentials → OAuth
  client ID (Web application). Authorized redirect URI:
  `${ACCOUNT_BASE_URL}/api/auth/callback/google`. Configure the OAuth consent
  screen first, or the client will only work for your own account.
  <https://developers.google.com/identity/protocols/oauth2/web-server>
- **Microsoft** — Entra ID → App registrations → New registration, platform
  "Web", redirect `${ACCOUNT_BASE_URL}/api/auth/callback/microsoft`. Use a client
  secret (not a certificate); note the expiry, since Entra secrets expire.
  <https://learn.microsoft.com/entra/identity-platform/quickstart-register-app>
- **Apple** — Sign in with Apple requires a **paid Apple Developer Program
  membership** ($99/year); there is no free tier for it. In the developer
  portal, create an App ID with "Sign in with Apple" enabled, then a Services ID
  (that Services ID is your `APPLE_CLIENT_ID`), then a Sign in with Apple key.
  `APPLE_CLIENT_SECRET` is not a static string: it is a JWT you generate from
  that key and must regenerate before it expires (Apple caps the lifetime at six
  months). Return URL: `${ACCOUNT_BASE_URL}/api/auth/callback/apple`.
  <https://developer.apple.com/documentation/sign_in_with_apple>

  **App Store policy note:** if a Synara iOS app is ever shipped and offers any
  third-party sign-in (Google, GitHub, Microsoft), App Review requires Sign in
  with Apple to be offered alongside it. That is the reason Apple is wired up at
  all — for a web-only or self-hosted deployment, leaving `APPLE_*` unset is
  perfectly fine and the button simply does not render.

## Deploying to Railway

The service runs TypeScript directly under Bun; only the ceremony UI is built.

- **Build command:** `bun install && bun run build`
- **Start command:** `bun run start`
- **Root directory:** `apps/api` (or run the commands with `--cwd apps/api` from
  the monorepo root, since this is a workspace package).
- **Variables:** set `DATABASE_URL`, `BETTER_AUTH_SECRET`, and
  `ACCOUNT_BASE_URL` (to the Railway public domain) at minimum. Leave `PORT` to
  Railway — it injects one, and `loadApiConfig` honours it.

For Postgres, either add Railway's own Postgres plugin or point at
**PlanetScale**. A PlanetScale Postgres `DATABASE_URL` must include TLS:

```
postgres://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full
```

`sslmode=require` also connects but skips certificate verification; prefer
`verify-full`. Migrations run on boot, so the first deploy provisions the schema
with no extra release step.

Other platforms work the same way: any host that can run `bun run start` with a
Postgres URL and a persistent public origin is enough. There is no filesystem
state — everything lives in Postgres.

## Build and run

The server has **no bundle step**. It runs TypeScript directly under Bun, in both
development and production, so `build` exists solely to produce the ceremony UI:

| Script     | What it does                                                              |
| ---------- | ------------------------------------------------------------------------- |
| `build`    | Alias for `build:ui`. The server needs no build; this is the whole build. |
| `build:ui` | `vite build` → `ui/dist`, the assets `src/staticUi.ts` serves.            |
| `start`    | Runs the server from `src/index.ts`. There is no `dist/index.mjs`.        |
| `dev`      | Same, with `--hot`.                                                       |
| `dev:ui`   | Vite dev server on :5788, proxying `/api` → :8788.                        |

**For packaging:** ship `src/`, `drizzle/`, `ui/dist/`, and `node_modules`, then run
`start`. Do not look for a compiled server entrypoint — unlike `@synara/server`,
which builds to `dist/index.mjs`, this app deliberately has none. If a bundled
server is ever wanted, add a `build:server` script and make `build` run both.

Serving `ui/dist` is optional at runtime: without it the API still starts and
answers non-`/api` paths with a placeholder, so a server-only deploy works.

## Tests

`bun run test` requires Postgres and a `TEST_DATABASE_URL`; without it the suites
skip. It also builds the UI on demand, because the static-serving tests assert
against a real bundle.

```sh
docker compose -f docker-compose.yml up -d
TEST_DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts bun run test
```

**Known trap:** the dev `.env` and the tests use different `BETTER_AUTH_SECRET`
values. Pointed at the same database, whichever runs second cannot decrypt the
stored JWKS row and every session-backed route returns 500. Clear it with
`delete from jwks;` or give the tests their own database.
