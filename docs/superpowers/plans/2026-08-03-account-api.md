# Synara Account Backend (apps/api) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the self-hostable Synara account service (`apps/api`): BetterAuth accounts (email/password + GitHub/Google/Apple/Microsoft), a Postgres-backed host registry, ceremony-only auth web pages, and `synara auth`/`synara status` CLI integration.

**Architecture:** One Hono service on Node/Bun serving BetterAuth at `/api/auth/*`, Synara routes at `/api/v1/*`, and a static Vite/React/Tailwind auth-ceremony UI same-origin. Drizzle ORM on Postgres 18 (docker-compose locally, PlanetScale in prod). No WebSockets, no heartbeats — presence is client-side. Spec: `docs/superpowers/specs/2026-08-03-account-backend-design.md`.

**Tech Stack:** Hono, BetterAuth (jwt + deviceAuthorization plugins), Drizzle ORM + drizzle-kit, node-postgres (pg), Vite + React 19 + Tailwind, Vitest, Effect CLI (existing, for synara subcommands).

## Global Constraints

- `bun fmt`, `bun lint`, `bun typecheck` must pass at the end (single final verification pass; don't re-run the full set per task).
- Tests run with `bun run test` (Vitest) — NEVER `bun test`.
- `packages/contracts` stays schema-only — no runtime logic.
- No secrets committed. `.env.example` documents variables; `.env` is gitignored.
- Integration tests require the local pg18 from `apps/api/docker-compose.yml`; tests that need a DB must skip gracefully (with a clear message) when `TEST_DATABASE_URL` is unset.
- All V1 constraints from the spec: no WebSockets/heartbeats/presence in the API; `relay_grants` NOT created; account features inert without `SYNARA_ACCOUNT_URL`.
- Workspace uses Bun + workspaces catalog; new deps are added to `apps/api/package.json` directly (not the catalog) unless shared.
- Monorepo commands run through turbo (`bun typecheck` etc.); apps/api must expose `dev`, `build`, `typecheck`, `test` scripts so turbo picks them up.

---

### Task 1: Scaffold apps/api workspace + docker-compose + config module

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/docker-compose.yml`
- Create: `apps/api/.env.example`
- Create: `apps/api/src/config.ts`
- Test: `apps/api/src/config.test.ts`
- Modify: `.gitignore` (ensure `apps/api/.env` ignored; check existing patterns first)

**Interfaces:**
- Produces: `loadApiConfig(env: Record<string, string | undefined>): ApiConfig` where `ApiConfig = { databaseUrl: string; baseUrl: string; authSecret: string; port: number; providers: { github?: OAuthPair; google?: OAuthPair; apple?: OAuthPair; microsoft?: OAuthPair }; email?: { resendApiKey?: string; smtpUrl?: string; from?: string }; allowedSignupEmails?: string[] }` and `OAuthPair = { clientId: string; clientSecret: string }`. Throws `ApiConfigError` (plain Error subclass with `message`) listing every missing required var.
- Produces: `enabledAuthMethods(config: ApiConfig): { emailPassword: true; social: Array<"github" | "google" | "apple" | "microsoft">; emailDelivery: boolean; signupRestricted: boolean }`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@synara/api",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --hot src/index.ts",
    "build": "bun run scripts/build.ts",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "bun run src/db/migrate.ts"
  },
  "dependencies": {
    "better-auth": "^1.4.4",
    "drizzle-orm": "^0.44.0",
    "hono": "^4.7.0",
    "@hono/node-server": "^1.14.0",
    "pg": "^8.16.0"
  },
  "devDependencies": {
    "@types/pg": "^8.15.0",
    "drizzle-kit": "^0.31.0",
    "typescript": "catalog:",
    "vitest": "catalog:"
  }
}
```

(Verify latest compatible versions with `bun add --dry-run` if installs fail; better-auth must be ≥1.4 for the deviceAuthorization plugin.)

- [ ] **Step 2: Create tsconfig.json** (mirror `apps/server/tsconfig.json` compiler options minus Effect language-service plugin; `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"strict": true`, include `src`)

- [ ] **Step 3: Create docker-compose.yml**

```yaml
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_USER: synara
      POSTGRES_PASSWORD: synara
      POSTGRES_DB: synara_accounts
    ports:
      - "5432:5432"
    volumes:
      - synara-api-pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U synara -d synara_accounts"]
      interval: 5s
      timeout: 3s
      retries: 10
volumes:
  synara-api-pg:
```

- [ ] **Step 4: Create .env.example** documenting every variable with comments: `DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts`, `BETTER_AUTH_SECRET=` (generate: `openssl rand -base64 32`), `ACCOUNT_BASE_URL=http://localhost:8788`, `PORT=8788`, `GITHUB_CLIENT_ID/SECRET`, `GOOGLE_CLIENT_ID/SECRET`, `APPLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `RESEND_API_KEY`, `EMAIL_FROM`, `ACCOUNT_ALLOWED_SIGNUP_EMAILS` (comma-separated). State: providers activate only when both halves of the pair are present.

- [ ] **Step 5: Write failing config tests** in `apps/api/src/config.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { ApiConfigError, enabledAuthMethods, loadApiConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  BETTER_AUTH_SECRET: "s".repeat(32),
  ACCOUNT_BASE_URL: "https://accounts.example.com",
};

describe("loadApiConfig", () => {
  it("throws listing every missing required var", () => {
    expect(() => loadApiConfig({})).toThrow(ApiConfigError);
    expect(() => loadApiConfig({})).toThrow(/DATABASE_URL.*BETTER_AUTH_SECRET.*ACCOUNT_BASE_URL/s);
  });
  it("activates a provider only when both id and secret exist", () => {
    const config = loadApiConfig({ ...base, GITHUB_CLIENT_ID: "id" });
    expect(config.providers.github).toBeUndefined();
    const full = loadApiConfig({ ...base, GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "sec" });
    expect(full.providers.github).toEqual({ clientId: "id", clientSecret: "sec" });
  });
  it("defaults port to 8788 and parses PORT", () => {
    expect(loadApiConfig(base).port).toBe(8788);
    expect(loadApiConfig({ ...base, PORT: "9000" }).port).toBe(9000);
  });
  it("parses the signup allowlist", () => {
    const config = loadApiConfig({ ...base, ACCOUNT_ALLOWED_SIGNUP_EMAILS: "a@x.com, b@y.com" });
    expect(config.allowedSignupEmails).toEqual(["a@x.com", "b@y.com"]);
  });
});

describe("enabledAuthMethods", () => {
  it("reports enabled socials, email delivery, and restriction", () => {
    const config = loadApiConfig({
      ...base,
      GITHUB_CLIENT_ID: "i", GITHUB_CLIENT_SECRET: "s",
      RESEND_API_KEY: "re_x", EMAIL_FROM: "noreply@example.com",
      ACCOUNT_ALLOWED_SIGNUP_EMAILS: "a@x.com",
    });
    expect(enabledAuthMethods(config)).toEqual({
      emailPassword: true,
      social: ["github"],
      emailDelivery: true,
      signupRestricted: true,
    });
  });
});
```

- [ ] **Step 6: Run tests, verify FAIL** — `cd apps/api && bunx vitest run src/config.test.ts` → module not found.

- [ ] **Step 7: Implement `src/config.ts`** — plain functions, no deps. `ApiConfigError extends Error`. Collect missing required vars into one message. Social order in `enabledAuthMethods`: github, google, apple, microsoft (only enabled ones).

- [ ] **Step 8: Run tests, verify PASS.** Run `bun install` from repo root once so the workspace links.

- [ ] **Step 9: Commit** — `feat(api): scaffold apps/api workspace, pg18 compose, config module`

---

### Task 2: Drizzle schema + migrations + db bootstrap

**Files:**
- Create: `apps/api/drizzle.config.ts`
- Create: `apps/api/src/db/schema.ts`
- Create: `apps/api/src/db/index.ts`
- Create: `apps/api/src/db/migrate.ts`
- Create: `apps/api/drizzle/` (generated SQL, committed)
- Test: `apps/api/src/db/schema.test.ts`

**Interfaces:**
- Produces: `createDb(databaseUrl: string): { db: NodePgDatabase<typeof schema>; pool: pg.Pool }` from `src/db/index.ts`; `runMigrations(databaseUrl: string): Promise<void>` from `src/db/migrate.ts` (used on boot and by tests).
- Produces: schema exports `user, session, account, verification, deviceCode, jwks` (BetterAuth tables) and `hosts, hostTokens` (Synara tables) with the exact columns below.

- [ ] **Step 1: Generate the BetterAuth schema.** Create a minimal `src/auth.ts` stub exporting a BetterAuth instance configured with drizzleAdapter + jwt() + deviceAuthorization() plugins (full wiring lands in Task 4 — here it exists so the CLI can introspect plugins):

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import { createDb } from "./db";

export const createAuth = (options: {
  databaseUrl: string; baseUrl: string; secret: string;
}) => {
  const { db } = createDb(options.databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, { provider: "pg" }),
    baseURL: options.baseUrl,
    secret: options.secret,
    emailAndPassword: { enabled: true },
    plugins: [jwt(), deviceAuthorization()],
  });
};
```

Then run `bunx @better-auth/cli generate --config src/auth.ts --output src/db/auth-schema.ts` and re-export from `src/db/schema.ts`. (If the CLI flags differ in the installed version, check `bunx @better-auth/cli generate --help`; the deliverable is a committed Drizzle schema file containing BetterAuth's tables.)

- [ ] **Step 2: Add Synara tables to `src/db/schema.ts`**

```ts
import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { user } from "./auth-schema";
export * from "./auth-schema";

export type HostEndpoint = { url: string; transport: "lan" | "tailscale" | "public" };

export const hosts = pgTable(
  "hosts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    environmentId: text("environment_id").notNull(),
    name: text("name").notNull(),
    platform: text("platform", { enum: ["darwin", "linux", "windows"] }).notNull(),
    kind: text("kind", { enum: ["local", "ssh-managed"] }).notNull(),
    endpoints: jsonb("endpoints").$type<HostEndpoint[]>().notNull().default([]),
    appVersion: text("app_version"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("hosts_user_environment_unique").on(table.userId, table.environmentId)],
);

export const hostTokens = pgTable("host_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id").notNull().references(() => hosts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
```

- [ ] **Step 3: Create `drizzle.config.ts`** (schema `./src/db/schema.ts`, out `./drizzle`, dialect `postgresql`, url from `process.env.DATABASE_URL`). Create `src/db/index.ts` (`pg.Pool` + `drizzle(pool, { schema })`) and `src/db/migrate.ts` using `drizzle-orm/node-postgres/migrator` `migrate()` with `migrationsFolder` resolved relative to the module (`new URL("../../drizzle", import.meta.url)`), so it works from any cwd.

- [ ] **Step 4: Generate + commit migrations** — `bunx drizzle-kit generate` with `DATABASE_URL` set to anything syntactically valid (generate doesn't connect). Inspect the SQL: one migration containing BetterAuth tables + hosts + host_tokens.

- [ ] **Step 5: Write DB integration test** `src/db/schema.test.ts` — skips without a database:

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./index";
import { runMigrations } from "./migrate";
import { hosts, user } from "./schema";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("schema", () => {
  beforeAll(async () => { await runMigrations(url!); });
  it("enforces unique (userId, environmentId)", async () => {
    const { db, pool } = createDb(url!);
    const [u] = await db.insert(user).values({
      id: crypto.randomUUID(), name: "t", email: `${crypto.randomUUID()}@x.com`,
      emailVerified: false, createdAt: new Date(), updatedAt: new Date(),
    }).returning();
    const row = { userId: u.id, environmentId: "env-1", name: "MacBook", platform: "darwin" as const, kind: "local" as const, endpoints: [] };
    await db.insert(hosts).values(row);
    await expect(db.insert(hosts).values(row)).rejects.toThrow();
    await pool.end();
  });
});
```

(Adjust the `user` insert columns to whatever the generated auth-schema requires — read the generated file.)

- [ ] **Step 6: Run** — `docker compose -f apps/api/docker-compose.yml up -d`, wait for healthy, then `cd apps/api && TEST_DATABASE_URL=postgres://synara:synara@localhost:5432/synara_accounts bunx vitest run src/db` → PASS. Also verify skip works without the var.

- [ ] **Step 7: Commit** — `feat(api): drizzle schema, committed migrations, db bootstrap`

---

### Task 3: Account contracts in packages/contracts

**Files:**
- Create: `packages/contracts/src/account.ts`
- Modify: `packages/contracts/src/index.ts` (add `export * from "./account"`)
- Test: `packages/contracts/src/account.test.ts`

**Interfaces:**
- Produces (effect Schema, matching existing contracts style — see `packages/contracts/src/environment.ts` for idiom; import `EnvironmentId`, `TrimmedNonEmptyString` from `./baseSchemas`):
  - `AccountHostTransport = Schema.Literals(["lan", "tailscale", "public"])`
  - `AccountHostEndpoint = Schema.Struct({ url: TrimmedNonEmptyString, transport: AccountHostTransport })`
  - `AccountHostPlatform = Schema.Literals(["darwin", "linux", "windows"])`
  - `AccountHostKind = Schema.Literals(["local", "ssh-managed"])`
  - `AccountHost = Schema.Struct({ id: TrimmedNonEmptyString, environmentId: EnvironmentId, name: TrimmedNonEmptyString, platform: AccountHostPlatform, kind: AccountHostKind, endpoints: Schema.Array(AccountHostEndpoint), appVersion: Schema.optional(TrimmedNonEmptyString), createdAt: TrimmedNonEmptyString, lastSeenAt: TrimmedNonEmptyString })` (timestamps ISO strings)
  - `AccountMe = Schema.Struct({ id, name, email: TrimmedNonEmptyString, image: Schema.optional(TrimmedNonEmptyString) })`
  - `RegisterHostRequest = Schema.Struct({ environmentId: EnvironmentId, name, platform: AccountHostPlatform, kind: AccountHostKind, endpoints: Schema.Array(AccountHostEndpoint), appVersion: Schema.optional(TrimmedNonEmptyString) })`
  - `RegisterHostResponse = Schema.Struct({ host: AccountHost, hostToken: TrimmedNonEmptyString })`
  - `UpdateHostRequest = Schema.Struct({ name: Schema.optional(...), endpoints: Schema.optional(...), appVersion: Schema.optional(...) })`
  - `ListHostsResponse = Schema.Struct({ hosts: Schema.Array(AccountHost) })`
  - `AccountSessionSummary = Schema.Struct({ id, createdAt, lastActiveAt: Schema.optional(TrimmedNonEmptyString), userAgent: Schema.optional(TrimmedNonEmptyString), current: Schema.Boolean })`
  - `ListSessionsResponse = Schema.Struct({ sessions: Schema.Array(AccountSessionSummary) })`
  - `InstanceInfo = Schema.Struct({ version: TrimmedNonEmptyString, authMethods: Schema.Struct({ emailPassword: Schema.Boolean, social: Schema.Array(Schema.Literals(["github", "google", "apple", "microsoft"])) }), emailDelivery: Schema.Boolean, signupRestricted: Schema.Boolean })`
  - `AccountErrorCode = Schema.Literals(["unauthorized", "host_not_found", "token_revoked", "signup_restricted", "environment_already_linked", "validation_failed", "rate_limited", "internal_error"])`
  - `AccountErrorBody = Schema.Struct({ error: AccountErrorCode, message: TrimmedNonEmptyString })`

- [ ] **Step 1: Write failing decode/encode tests** in `account.test.ts` (follow the pattern of an existing contracts test, e.g. `git.test.ts`): decode a valid `RegisterHostRequest`, reject a bad transport literal, reject empty name.
- [ ] **Step 2: Run** — `cd packages/contracts && bunx vitest run src/account.test.ts` → FAIL.
- [ ] **Step 3: Implement `account.ts`**, export from `index.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(contracts): account + host registry schemas`

---

### Task 4: BetterAuth wiring — providers from config, allowlist hook, device flow, JWKS

**Files:**
- Modify: `apps/api/src/auth.ts` (full version replacing Task 2's stub)
- Test: `apps/api/src/auth.test.ts`

**Interfaces:**
- Consumes: `ApiConfig` (Task 1), `createDb` (Task 2).
- Produces: `createAuth(config: ApiConfig, db: NodePgDatabase<typeof schema>): ReturnType<typeof betterAuth>` — social providers included only when configured; `databaseHooks.user.create.before` rejects sign-ups whose email is not in `allowedSignupEmails` (when set) by throwing `new APIError("FORBIDDEN", { message: "signup_restricted" })`; email delivery callbacks wired to Resend when configured, no-op logger otherwise; `basePath: "/api/auth"`; rate limiting enabled (BetterAuth built-in, default window) so device-code endpoints are covered; `trustedOrigins` includes `synara://` and `synara-dev://`.

- [ ] **Step 1: Write failing tests** (integration, `describe.skipIf(!process.env.TEST_DATABASE_URL)`) using `auth.api` server-side calls:

```ts
// 1. email/password signup + sign-in round-trip
const res = await auth.api.signUpEmail({ body: { email, password: "hunter2hunter2", name: "Dylan" } });
expect(res.user.email).toBe(email);
// 2. allowlist: createAuth with allowedSignupEmails: ["only@x.com"] rejects other emails
await expect(auth.api.signUpEmail({ body: { email: "nope@x.com", ... } })).rejects.toMatchObject({ body: { message: "signup_restricted" } });
// 3. device flow end-to-end via auth.api: deviceCode request → approve with session → token poll returns session token
// 4. JWKS endpoint returns at least one key: auth.api.getJwks() (or handler GET /api/auth/jwks) has keys.length >= 1
```

Use unique emails per run (`${crypto.randomUUID()}@x.com`). For the device-flow test consult better-auth's deviceAuthorization docs for exact `auth.api` method names (`deviceCode`, `deviceApprove`, `deviceToken` or similar) — assert the flow: request returns `user_code`/`device_code`; approving with a signed-in session succeeds; polling exchanges `device_code` for a valid session token.

- [ ] **Step 2: Run** → FAIL (stub lacks providers/hooks).
- [ ] **Step 3: Implement full `createAuth`.** Providers spread conditionally from `config.providers`. Allowlist via `databaseHooks.user.create.before`. `emailVerification.sendVerificationEmail` + `emailAndPassword.sendResetPassword` post to Resend's REST API with `fetch` when `config.email?.resendApiKey` is set, else `console.warn` once. Export nothing else.
- [ ] **Step 4: Run** → PASS (with compose pg up).
- [ ] **Step 5: Commit** — `feat(api): betterauth wiring — config-driven providers, allowlist, device flow, jwks`

---

### Task 5: Host registry routes (/api/v1)

**Files:**
- Create: `apps/api/src/routes/v1.ts`
- Create: `apps/api/src/routes/hostAuth.ts`
- Create: `apps/api/src/hostTokens.ts`
- Test: `apps/api/src/routes/v1.test.ts`

**Interfaces:**
- Consumes: `createAuth` (Task 4), db + schema (Task 2), contracts (Task 3).
- Produces: `createV1Routes(deps: { auth: Auth; db: Db; config: ApiConfig }): Hono` mounted at `/api/v1` implementing the spec's route table exactly. `src/hostTokens.ts` exports `mintHostToken(): { token: string; hash: string }` (token = `synhost_` + 32 random bytes base64url; hash = SHA-256 hex) and `hashHostToken(token: string): string`.
- Error responses use `AccountErrorBody` shape: `{ error: <code>, message: <human text> }` with statuses: 401 unauthorized, 404 host_not_found, 403 token_revoked/signup_restricted, 409 environment_already_linked, 400 validation_failed.

**Authorization rules (the heart of the task):**
- Device-token auth: resolve via `auth.api.getSession({ headers })` (works for both cookie and bearer session tokens). Missing/invalid → 401.
- Host-token auth (`hostAuth.ts`): `Authorization: Bearer synhost_...` → hash → look up non-revoked `host_tokens` row → attach `hostId`; update `lastUsedAt` (fire-and-forget). Revoked → 403 `token_revoked`; unknown → 401.
- `PATCH /hosts/:id` accepts host token for its own `hostId` only.
- `DELETE /hosts/:id` accepts either a device token (owner check via `userId`) or the host's own host token.
- Cross-user isolation: every device-token query filters `eq(hosts.userId, session.user.id)`.

**Route behaviors:**
- `GET /me` → `AccountMe` from session user.
- `GET /hosts` → all rows for user, ISO timestamps.
- `POST /hosts` → validate body against `RegisterHostRequest` (decode with effect Schema from contracts; on failure 400 `validation_failed` with the parse message). If `(userId, environmentId)` exists: update the row in place (name/platform/kind/endpoints/appVersion, bump lastSeenAt), revoke existing tokens (`revokedAt = now()`), mint fresh token → this is the re-link rotation. Else insert. Respond `RegisterHostResponse` with plaintext token (only time it's shown).
- `PATCH /hosts/:id` → apply provided fields, bump `lastSeenAt`, return `{ host }`.
- `DELETE /hosts/:id` → delete row (tokens cascade). 204.
- `GET /sessions` → `auth.api.listSessions({ headers })` mapped to `AccountSessionSummary` (`current` = matching current session id).
- `DELETE /sessions/:id` → `auth.api.revokeSession`. 204.
- `GET /instance` → `InstanceInfo` (version from package.json import, `enabledAuthMethods(config)` mapped in). No auth.

- [ ] **Step 1: Write failing integration tests** — spin the whole Hono app (import `createApp` from Task 6 if done first is not possible: build a local test harness `new Hono().route("/api/v1", createV1Routes(deps))` plus `auth.handler` mounted; sign up two users via `auth.api`, get bearer tokens). Cover: 401 unauthenticated; register→list round-trip; re-register same environmentId rotates token (old host token 403s, new one works); PATCH with host token updates endpoints + lastSeenAt; PATCH with the *other host's* token → 401/403; user B cannot see or DELETE user A's host (list empty, delete 404); DELETE with device token removes host and its token; `/instance` reflects config without auth.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** `hostTokens.ts`, `hostAuth.ts`, `v1.ts`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(api): host registry routes with device/host token authorization`

---

### Task 6: App assembly + server entry + migrations on boot

**Files:**
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`
- Test: `apps/api/src/app.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `createApp(config: ApiConfig): { app: Hono; auth: Auth; pool: pg.Pool }` — mounts `auth.handler` on `/api/auth/*`, v1 routes on `/api/v1`, and static UI serving (Task 7 fills the directory; until then a fallback `200 text/html` placeholder for `/`). `src/index.ts`: `loadApiConfig(process.env)` → `runMigrations` → `serve({ fetch: app.fetch, port })` (`@hono/node-server`) with graceful shutdown on SIGTERM (`pool.end()`).

- [ ] **Step 1: Write failing test** — `createApp` with test config: `GET /api/v1/instance` 200; `GET /api/auth/jwks` 200 with keys; `GET /` returns 200 html; unknown `/api/v1/nope` → 404 JSON `AccountErrorBody`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Manual smoke:** `cd apps/api && cp .env.example .env` (fill DATABASE_URL/BETTER_AUTH_SECRET), `bun run dev`, then `curl localhost:8788/api/v1/instance` → JSON.
- [ ] **Step 6: Commit** — `feat(api): app assembly, boot migrations, server entry`

---

### Task 7: Auth ceremony UI (Vite + React + Tailwind)

**Files:**
- Create: `apps/api/ui/` — `index.html`, `vite.config.ts`, `src/main.tsx`, `src/App.tsx`, `src/pages/SignIn.tsx`, `src/pages/SignUp.tsx`, `src/pages/Device.tsx`, `src/pages/ResetPassword.tsx`, `src/pages/VerifyEmail.tsx`, `src/pages/Callback.tsx`, `src/styles.css`
- Modify: `apps/api/package.json` (ui deps: `react`, `react-dom`, `react-router-dom`, `tailwindcss` + `@tailwindcss/vite`, `better-auth` client, `@vitejs/plugin-react`; scripts: `dev:ui: vite dev ui`, build includes `vite build ui`)
- Modify: `apps/api/src/app.ts` (serve `ui/dist` via `serveStatic` from `@hono/node-server/serve-static`, SPA fallback to `index.html` for non-`/api` paths)

**Interfaces:**
- Consumes: `/api/auth/*` (BetterAuth client `createAuthClient({ baseURL: "" })` — same origin), `/api/v1/instance`.
- Produces: routed pages `/login`, `/signup`, `/device`, `/reset-password`, `/verify-email`, `/callback`.

**Page behaviors (implement exactly):**
- `/login`: fetch `/api/v1/instance`; render email/password form (only that + enabled social buttons). Social buttons call `authClient.signIn.social({ provider, callbackURL: "/callback" + preserved query })`. On success with `?redirect=device&user_code=X` → navigate to `/device?user_code=X`.
- `/signup`: mirror of login for email/password sign-up; show `signupRestricted` notice when instance says so.
- `/device`: reads `user_code` from query (editable input when absent); requires session (redirect to `/login?redirect=device&user_code=…` when signed out); calls the deviceAuthorization approve endpoint via authClient; success screen: "Device connected — you can close this tab."
- `/callback`: completes social sign-in; if `state` carried a device `user_code`, forward to `/device`; if query has `deep_link=synara` (set by desktop flows), attempt `location.href = "synara://auth/callback?code=…"` with visible fallback link "Return to Synara"; else show "Signed in — return to the app."
- `/reset-password`, `/verify-email`: thin wrappers over authClient flows with success/error states.
- Styling: Tailwind, minimal centered card, dark-friendly neutral palette; no component library.

- [ ] **Step 1: Scaffold vite app** (`ui/` with `@tailwindcss/vite`, react plugin, `server.proxy = { "/api": "http://localhost:8788" }`).
- [ ] **Step 2: Implement pages** per behaviors above.
- [ ] **Step 3: Wire static serving + SPA fallback in `app.ts`**; extend `app.test.ts`: after `vite build`, `GET /login` returns the SPA html (in test, skip if `ui/dist` absent).
- [ ] **Step 4: Manual verification** — compose up, `bun run dev` (api) + `bun run dev:ui`, walk: signup → login → device page approves a code minted via `curl` to the device-code endpoint. Fix what breaks.
- [ ] **Step 5: Commit** — `feat(api): auth ceremony UI (login, signup, device, reset, verify, callback)`

---

### Task 8: Account client in packages/shared

**Files:**
- Create: `packages/shared/src/account.ts` (add matching subpath export in `packages/shared/package.json` — follow the existing `./git` export pattern)
- Test: `packages/shared/src/account.test.ts`

**Interfaces:**
- Consumes: contracts (Task 3).
- Produces (plain fetch wrapper, no Effect requirement — match shared's existing style by reading `packages/shared/src/git.ts` first):
  - `createAccountClient(options: { baseUrl: string; fetch?: typeof fetch }): AccountClient`
  - `AccountClient` methods: `instance()`, `me(deviceToken)`, `listHosts(deviceToken)`, `registerHost(deviceToken, RegisterHostRequest)`, `updateHost(hostToken, hostId, UpdateHostRequest)`, `deleteHost(token, hostId)`, `requestDeviceCode()`, `pollDeviceToken(deviceCode)` (the last two call BetterAuth device endpoints; return typed results; poll respects `interval`/`slow_down`).
  - All methods decode responses with the contracts schemas and throw `AccountApiError { code: AccountErrorCode; status: number; message }` on error bodies.

- [ ] **Step 1: Failing tests with a stubbed `fetch`** — happy path decode for `instance`/`listHosts`/`registerHost`; error body → `AccountApiError` with code; device poll handles `authorization_pending` then success.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** — `feat(shared): typed account API client`

---

### Task 9: `synara auth` + `synara status` CLI commands

**Files:**
- Create: `apps/server/src/accountAuth.ts` (credential store + flows)
- Modify: `apps/server/src/main.ts` (register `auth` and `status` subcommands next to the `mcp` command group — follow its `Command.make` + `Command.withSubcommands` pattern exactly)
- Modify: `apps/server/src/config.ts` or nearest env plumbing: read `SYNARA_ACCOUNT_URL`
- Modify: `turbo.json` `globalEnv`: add `SYNARA_ACCOUNT_URL`
- Test: `apps/server/src/accountAuth.test.ts`

**Interfaces:**
- Consumes: `createAccountClient` (Task 8), the server's environment identity (`apps/server/src/environment/Layers/ServerEnvironment.ts` persists `environmentId` at `serverConfig.environmentIdPath` — reuse that file/value, do not invent a new ID).
- Produces in `accountAuth.ts`:
  - `readAccountCredentials(baseDir): Promise<AccountCredentials | undefined>` / `writeAccountCredentials(baseDir, creds)` — JSON file `account-credentials.json` in the Synara home dir, written with `mode: 0o600` (match `ServerSecretStore.ts` style); shape `{ accountUrl: string; deviceToken: string; hostToken?: string; hostId?: string }`.
  - `runAuthLogin(options: { accountUrl; baseDir; stdout })` — device flow: request code, print `Open <verification_uri_complete> and approve (code: XXXX-XXXX)`, poll, save token, then self-register host (environmentId + os.platform() + name = os.hostname() + endpoints from current server config LAN URL when derivable, else `[]`, kind `local`) and save hostToken/hostId. Prints success summary.
  - `runAuthLogout(...)` — best-effort `DELETE /hosts/:id` with host token + session revoke, then delete credentials file.
  - `runStatus(...)` — no account URL → print "Account features not configured (set SYNARA_ACCOUNT_URL)."; no credentials → "Not signed in — run `synara auth`."; else print user identity, this host, and table of all hosts (name, platform, kind, endpoints, lastSeenAt).

- [ ] **Step 1: Failing tests** — credential file round-trip sets 0600 (skip perms assert on win32); `runAuthLogin` against a mocked AccountClient (inject via options) saves both tokens and registers with the persisted environmentId; `runStatus` output for the three states (assert on captured stdout strings).
- [ ] **Step 2: Run** → FAIL (`cd apps/server && bunx vitest run src/accountAuth.test.ts`). **Step 3: Implement `accountAuth.ts`.** **Step 4: Run** → PASS.
- [ ] **Step 5: Register CLI commands in `main.ts`:** `synara auth` (default = login; subcommand `logout`), `synara status`. Both resolve `SYNARA_ACCOUNT_URL` from env (flag `--account-url` optional override) and reuse the parent command's `--home-dir` context like the mcp commands do.
- [ ] **Step 6: Manual smoke:** with api running locally + `SYNARA_ACCOUNT_URL=http://localhost:8788`, run `bun run dev` auth flow end-to-end: `synara auth` → approve in browser → `synara status` shows the host.
- [ ] **Step 7: Commit** — `feat(server): synara auth/status — device flow, host self-registration`

---

### Task 10: Startup best-effort host refresh + docs + final verification

**Files:**
- Modify: `apps/server/src/effectServer.ts` or the startup path in `main.ts` (choose the spot where the server has its config + environment id ready): fire ONE best-effort `updateHost` (refresh endpoints, bump lastSeenAt) when credentials exist — `void`ed promise with `.catch(() => {})`, never blocks startup, never retries.
- Create: `apps/api/README.md` — self-hosting guide: compose up, env vars, OAuth app registration pointers (incl. Apple/App Store note from the spec), Railway deploy notes (build command, PlanetScale `DATABASE_URL`), explicit "no secrets in repo; instance off by default" statements.
- Test: `apps/server/src/accountAuth.test.ts` (extend: refresh helper called once with current endpoints; silent on network error)

**Interfaces:**
- Consumes: `readAccountCredentials`, `createAccountClient`.
- Produces: `refreshHostRegistration(options): Promise<void>` in `accountAuth.ts` (exported; called from startup).

- [ ] **Step 1: Failing test** for `refreshHostRegistration` (mocked client: called with hostId + endpoints; a rejecting client resolves void without throwing).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement + wire into startup.** **Step 4: Run** → PASS.
- [ ] **Step 5: Write README.md.**
- [ ] **Step 6: End-to-end verification (spec's checklist):** compose up → email/password signup in UI → `synara auth` from a second shell → `synara status` shows account → host appears in `GET /api/v1/hosts` → revoke host token via re-link → old token 403s.
- [ ] **Step 7: Full workspace gate:** `bun fmt && bun lint && bun typecheck` and `bun run test` in `apps/api`, `packages/contracts`, `packages/shared`, `apps/server`. Fix fallout.
- [ ] **Step 8: Commit** — `feat(server): best-effort host refresh on startup; api self-hosting docs`

---

## Self-Review Notes

- Spec coverage: architecture (T1/T6), schema (T2), contracts (T3), auth methods + allowlist + device flow + JWKS (T4), route table + token rules + rotation (T5), ceremony UI incl. deep-link callback (T7), shared client (T8), CLI + credential storage + self-registration (T9), startup refresh + docs + e2e (T10). Deferred per spec: relay_grants, desktop in-app UI, iOS.
- Deep-link: V1 ships the `/callback` page's `synara://` redirect (T7) but no Electron protocol handler — matches the spec's "V1 implementation boundary."
- BetterAuth API names (device flow, JWKS) vary slightly by version: tasks instruct implementers to consult the installed version's docs/types rather than trust exact method names here.
