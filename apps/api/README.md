# @synara/api

The Synara account service: BetterAuth at `/api/auth/*`, account/host routes under
`/api/v1`, and the auth ceremony UI on every other path.

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
