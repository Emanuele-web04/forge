# @synara/api

The Synara account service: WorkOS AuthKit for identity, plus account/host
routes under `/api/v1`.

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

## Identity: WorkOS AuthKit

This service does not store users, passwords, sessions, or signing keys.
WorkOS owns all of that; the database here holds only the host registry
(`hosts`, `host_tokens`), and `hosts.user_id` is an opaque WorkOS user id with
no foreign key behind it.

What that means in practice:

- **Sign-in methods are dashboard toggles, not env vars.** Email/password,
  Google, GitHub, Microsoft and the rest are enabled per-application in the
  WorkOS dashboard. There are no OAuth client ids or secrets to register here,
  and no provider pairs in the environment.
- **Email delivery is WorkOS's.** Verification and password-reset mail is sent
  by WorkOS, so there is no SMTP or Resend configuration.
- **The JWKS is WorkOS's, served by WorkOS.** This service only reads it, at
  `https://api.workos.com/sso/jwks/{WORKOS_CLIENT_ID}`. Nothing is generated or
  stored locally, so there is no key material to rotate or lose.
- **Access tokens are checked against an expected issuer.** WorkOS mints `iss`
  as `https://api.workos.com/` — with the trailing slash. If you configure a
  custom auth domain in the dashboard, WorkOS issues under that domain instead
  and you must set `WORKOS_ISSUER` to match, or every token is rejected.

### Dashboard setup

1. Create an AuthKit application at <https://dashboard.workos.com>.
2. Under **Authentication**, enable the sign-in methods you want.
3. Under **Authentication → CLI Auth**, **enable CLI Auth**. The `synara auth`
   device flow uses the device authorization grant, and the endpoint returns an
   error until this is switched on.
4. Add `${ACCOUNT_BASE_URL}` to the allowed redirect URIs.
5. Copy the API key and client id into `WORKOS_API_KEY` / `WORKOS_CLIENT_ID`.

## Quick start (local)

```sh
docker compose -f apps/api/docker-compose.yml up -d          # Postgres 18 on :5432
cp apps/api/.env.example apps/api/.env                       # then fill in the WorkOS keys
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

| Variable            | Required | Default                          | Purpose                                                  |
| ------------------- | -------- | -------------------------------- | -------------------------------------------------------- |
| `DATABASE_URL`      | yes      | —                                | Postgres connection string for the host registry.        |
| `WORKOS_API_KEY`    | yes      | —                                | WorkOS secret key (`sk_…`). Server-side only.            |
| `WORKOS_CLIENT_ID`  | yes      | —                                | WorkOS AuthKit client id (`client_…`).                   |
| `ACCOUNT_BASE_URL`  | yes      | —                                | Public origin of this instance.                          |
| `PORT`              | no       | `8788`                           | HTTP listen port.                                        |
| `WORKOS_API_URL`    | no       | `https://api.workos.com`         | WorkOS API origin. Override only to point at a stand-in. |
| `WORKOS_JWKS_URL`   | no       | `{API_URL}/sso/jwks/{CLIENT_ID}` | Full JWKS URL. Override only to point at a stand-in.     |
| `WORKOS_ISSUER`     | no       | `{API_URL}/`                     | Expected `iss` claim. Set only for a custom auth domain. |
| `TEST_DATABASE_URL` | tests    | —                                | Database the Vitest suites use. Without it they skip.    |

A missing required variable fails the boot with an explicit
`Missing required environment variables: …` rather than starting half-configured.

## Deploying to Railway

The service runs TypeScript directly under Bun, with no build step at all.

- **Build command:** `bun install`
- **Start command:** `bun run start`
- **Root directory:** `apps/api` (or run the commands with `--cwd apps/api` from
  the monorepo root, since this is a workspace package).
- **Variables:** set `DATABASE_URL`, `WORKOS_API_KEY`, `WORKOS_CLIENT_ID`, and
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

The server has **no bundle step**. It runs TypeScript directly under Bun, in
both development and production.

| Script  | What it does                                                       |
| ------- | ------------------------------------------------------------------ |
| `build` | Prints `no build step`. Kept so generic `bun run build` CI passes. |
| `start` | Runs the server from `src/index.ts`. There is no `dist/index.mjs`. |
| `dev`   | Same, with `--hot`.                                                |

**For packaging:** ship `src/`, `drizzle/`, and `node_modules`, then run
`start`. Do not look for a compiled server entrypoint — unlike `@synara/server`,
which builds to `dist/index.mjs`, this app deliberately has none.

## Tests

`bun run test` requires Postgres and a `TEST_DATABASE_URL`; without it the
database-backed suites skip. WorkOS is never called: `src/testing/fakeWorkos.ts`
serves a JWKS from a freshly generated key pair and mints access tokens signed
by it, so the auth path is exercised end to end with no network.

```sh
docker compose -f docker-compose.yml up -d
TEST_DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts bun run test
```

Pointing the tests at the same database as dev is safe — there is no shared key
material for the two to fight over.
