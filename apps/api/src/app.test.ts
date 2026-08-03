import type { AccountErrorBody } from "@synara/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { ApiConfig } from "./config";
import { runMigrations } from "./db/migrate";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

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

  it("serves the placeholder UI for non-API routes", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("Synara accounts");
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
