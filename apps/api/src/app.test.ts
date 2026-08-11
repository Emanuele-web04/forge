import type { AccountErrorBody } from "@synara/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_MAX_BODY_BYTES, createApp } from "./app";
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
    const built = await createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/api/v1/instance");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string };
    expect(body.version).toBeTruthy();
  });

  it("returns a JSON AccountErrorBody for unknown API routes", async () => {
    const built = await createApp(baseConfig);
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
    const built = await createApp(baseConfig);
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

  // An unauthenticated caller must not be able to make the server buffer an
  // arbitrarily large body before schema validation runs. At the boundary the
  // limiter admits the request (it then fails ordinary validation); one byte
  // over answers 413 in the documented error shape.
  it("rejects a request body over the size limit with a 413 error body", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    const post = (body: string) =>
      built.app.request("/api/v1/auth/otp/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });

    const filler = (size: number) =>
      `{"email":"a@example.com","pad":"${"x".repeat(size)}"}`.slice(0, size);

    const atLimit = await post(filler(API_MAX_BODY_BYTES));
    expect(atLimit.status).not.toBe(413);

    const oneOver = await post(filler(API_MAX_BODY_BYTES + 1));
    expect(oneOver.status).toBe(413);
    const body = (await oneOver.json()) as AccountErrorBody;
    expect(body.error).toBe("validation_failed");
    expect(body.message).not.toContain("x".repeat(32));
  });

  it("points non-API paths at the repo instead of returning the API error body", async () => {
    const built = await createApp(baseConfig);
    pool = built.pool;

    const res = await built.app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toContain("Sign in from the Synara app");
    expect(body).toContain("https://github.com/Emanuele-web04/synara");
  });
});
