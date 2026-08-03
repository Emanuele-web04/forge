import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccountErrorBody } from "@synara/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { ApiConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { hasUiBuild } from "./staticUi";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The SPA assertions below are only meaningful against a real `ui/dist`, so the
 * suite builds one rather than skipping itself into a false pass. This runs at
 * module load — before `describe` is collected — because `mountUi` decides how
 * to serve at `createApp` time. Repeat runs are free: an existing dist is reused.
 */
function ensureUiBuild(): void {
  if (hasUiBuild()) return;
  execFileSync("bunx", ["vite", "build", "--config", "ui/vite.config.ts"], {
    cwd: API_ROOT,
    stdio: "inherit",
    timeout: 180_000,
  });
}

if (TEST_DATABASE_URL) ensureUiBuild();

describe.skipIf(!TEST_DATABASE_URL)("createApp", () => {
  const databaseUrl = TEST_DATABASE_URL as string;

  const baseConfig: ApiConfig = {
    databaseUrl,
    baseUrl: "http://localhost:8788",
    authSecret: "s".repeat(32),
    port: 8788,
    providers: {},
  };

  let pool: Awaited<ReturnType<typeof createApp>>["pool"];

  beforeAll(async () => {
    await runMigrations(databaseUrl);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("serves v1 instance info", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ authMethods: { emailPassword: true } });
  });

  it("serves auth jwks", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/auth/jwks");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { keys: unknown[] };
    expect(body.keys.length).toBeGreaterThanOrEqual(1);
  });

  // `ensureUiBuild` guarantees a real bundle, so these assert the built UI
  // unconditionally rather than degrading to the placeholder.
  it("serves the built UI for non-API routes", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    expect(hasUiBuild()).toBe(true);

    const res = await built.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="root">');
  });

  // Client-side routes must survive a direct hit, not just navigation from "/".
  it("serves the SPA document for /login", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/login");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('<div id="root">');
    expect(body).toContain("/assets/");
  });

  it("serves the hashed bundle referenced by the SPA document", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const html = await (await built.app.request("/login")).text();
    const scriptSrc = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(scriptSrc).toBeDefined();

    const res = await built.app.request(scriptSrc as string);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
  });

  it("returns a JSON AccountErrorBody for unknown API routes", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/v1/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as AccountErrorBody;
    expect(body.error).toBe("validation_failed");
    expect(typeof body.message).toBe("string");
  });
});
