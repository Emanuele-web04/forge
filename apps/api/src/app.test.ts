import type { AccountErrorBody } from "@synara/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import type { ApiConfig } from "./config";
import { runMigrations } from "./db/migrate";
import { startFakeWorkos, type FakeWorkos } from "./testing/fakeWorkos";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("createApp", () => {
  const databaseUrl = TEST_DATABASE_URL as string;

  let workos: FakeWorkos;
  let baseConfig: ApiConfig;
  let pool: Awaited<ReturnType<typeof createApp>>["pool"];

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    workos = await startFakeWorkos();
    baseConfig = workos.config({ databaseUrl });
  });

  afterAll(async () => {
    await pool.end();
    await workos.close();
  });

  it("serves v1 instance info", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBeTruthy();
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

  // The net under every /api/ route: whatever throws, the client still gets the
  // documented JSON shape instead of Hono's plain-text "Internal Server Error".
  it("maps an unhandled throw under /api/ onto the error contract", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    built.app.get("/api/v1/boom", () => {
      throw new Error("simulated downstream failure");
    });

    const res = await built.app.request("/api/v1/boom");
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as AccountErrorBody;
    expect(body.error).toBe("internal_error");
    expect(typeof body.message).toBe("string");
  });

  // TASK2: the AuthKit callback and device pages land here; for now a non-API
  // path only has to stay up rather than 404 into the API error shape.
  it("answers non-API paths without the API error body", async () => {
    const built = createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).not.toContain("application/json");
  });
});
