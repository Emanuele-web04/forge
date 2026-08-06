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
- **The JWKS is WorkOS's, served by WorkOS.** This service only reads it.
  Nothing is generated or stored locally, so there is no key material to rotate
  or lose.
- **The issuer and JWKS URL are discovered, not guessed.** On its first token
  verification the service fetches WorkOS's OIDC metadata document at
  `{WORKOS_API_URL}/user_management/{WORKOS_CLIENT_ID}/.well-known/openid-configuration`
  and caches the `issuer` and `jwks_uri` it returns for the process lifetime.
  This matters: WorkOS scopes `iss` to the **environment's** client id
  (`https://api.workos.com/user_management/client_…`), which is _not_
  `WORKOS_CLIENT_ID` whenever your AuthKit application is not the environment
  default. Any locally derived issuer would reject every real token.
- **Discovery failure is fatal, by design.** Without a trusted issuer a token
  minted for some other tenancy could pass, so verification errors out naming
  the metadata URL rather than relaxing the check.
- **`WORKOS_ISSUER` / `WORKOS_JWKS_URL` are overrides.** Set them only for a
  custom auth domain or a stand-in that serves no metadata document; an
  explicit value always wins over discovery.

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

## Developing without a WorkOS account

`scripts/fake-workos.ts` runs the same in-process double the test suite uses as
a standalone server, so the full `synara auth` flow works with no WorkOS
tenancy and no network. It auto-approves device authorizations on a timer,
standing in for a human clicking through the hosted page — which is what makes
the flow headless.

```sh
bun run --cwd apps/api scripts/fake-workos.ts        # :8790, approves after 5s
```

It prints the environment to point the API at:

```sh
export WORKOS_API_URL=http://127.0.0.1:8790
export WORKOS_API_KEY=fake
export WORKOS_CLIENT_ID=client_01FAKE
```

The stub serves the same OIDC metadata document real WorkOS does — including an
environment-scoped issuer that differs from the client id — so the discovery
path is exactly the one production takes, and neither `WORKOS_ISSUER` nor
`WORKOS_JWKS_URL` needs setting.

Start the API with those set, then run `synara auth` as usual: the CLI prints a
code, the stub approves it a few seconds later, and you end up with a real
credentials file and a registered host.

| Flag                 | Default         | Purpose                                                                             |
| -------------------- | --------------- | ----------------------------------------------------------------------------------- |
| `--port`             | `8790`          | Listen port.                                                                        |
| `--approve-after`    | `5`             | Seconds before a device authorization self-approves; `0` approves immediately.      |
| `--client-id`        | `client_01FAKE` | Client id to serve.                                                                 |
| `--access-token-ttl` | `5m`            | Access-token lifetime. Set something like `30s` to exercise the CLI's refresh path. |

The stub mints **single-use refresh tokens**, exactly as WorkOS does, so a
client that fails to persist a rotation is locked out here the same way it would
be in production. It is dev tooling only — nothing in `src/` imports it, and it
is never reachable from a deployed instance.

### Manual checklist against a real WorkOS tenancy

The stub verifies the shape of the flow, not WorkOS's behaviour. Before
trusting an instance against real WorkOS, confirm by hand:

1. **CLI Auth is enabled** in the dashboard (Authentication → CLI Auth) —
   `POST /api/v1/auth/device` errors until it is.
2. `synara auth` prints a WorkOS URL, and approving in a browser completes the
   CLI poll.
3. `synara status` resolves your real name and email through `GET /me`.
4. A command run more than ~5 minutes after signing in still works — that is the
   refresh path, and the credentials file should hold a changed token pair
   afterwards.
5. Signing out of all sessions in the WorkOS dashboard makes the next refresh
   fail with a 4xx, and the CLI reports the session as expired rather than
   hanging or looping.
6. If you configured a custom auth domain, `WORKOS_ISSUER` matches it —
   otherwise every token is rejected. With no custom domain, leave it unset:
   discovery resolves the environment-scoped issuer, and a hand-written guess
   is the one thing that reliably breaks this.

## Environment variables

| Variable            | Required | Default                  | Purpose                                                  |
| ------------------- | -------- | ------------------------ | -------------------------------------------------------- |
| `DATABASE_URL`      | yes      | —                        | Postgres connection string for the host registry.        |
| `WORKOS_API_KEY`    | yes      | —                        | WorkOS secret key (`sk_…`). Server-side only.            |
| `WORKOS_CLIENT_ID`  | yes      | —                        | WorkOS AuthKit client id (`client_…`).                   |
| `ACCOUNT_BASE_URL`  | yes      | —                        | Public origin of this instance.                          |
| `PORT`              | no       | `8788`                   | HTTP listen port.                                        |
| `WORKOS_API_URL`    | no       | `https://api.workos.com` | WorkOS API origin. Override only to point at a stand-in. |
| `WORKOS_JWKS_URL`   | no       | discovered (`jwks_uri`)  | Full JWKS URL. Override only to point at a stand-in.     |
| `WORKOS_ISSUER`     | no       | discovered (`issuer`)    | Expected `iss` claim. Set only for a custom auth domain. |
| `TEST_DATABASE_URL` | tests    | —                        | Database the Vitest suites use. Without it they skip.    |

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
serves a JWKS from a freshly generated key pair, mints access tokens signed by
it, and answers the device and refresh grants, so the auth path is exercised end
to end with no network. The same module backs the dev stub above.

```sh
docker compose -f docker-compose.yml up -d
TEST_DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts bun run test
```

Pointing the tests at the same database as dev is safe — there is no shared key
material for the two to fight over.
