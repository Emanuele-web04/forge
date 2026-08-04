import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAuth } from "./auth";
import type { ApiConfig } from "./config";
import { createDb } from "./db";
import { runMigrations } from "./db/migrate";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DATABASE_URL)("createAuth", () => {
  const databaseUrl = TEST_DATABASE_URL as string;
  let pool: Awaited<ReturnType<typeof createDb>>["pool"];

  const baseConfig: ApiConfig = {
    databaseUrl,
    baseUrl: "http://localhost:8788",
    authSecret: "s".repeat(32),
    port: 8788,
    providers: {},
  };

  function uniqueEmail(): string {
    return `${randomUUID()}@x.com`;
  }

  beforeAll(async () => {
    await runMigrations(databaseUrl);
    const created = createDb(databaseUrl);
    pool = created.pool;
  });

  afterAll(async () => {
    await pool.end();
  });

  it("signs up and signs in via email/password", async () => {
    const { db } = createDb(databaseUrl);
    const auth = createAuth(baseConfig, db);
    const email = uniqueEmail();

    const signUpResult = await auth.api.signUpEmail({
      body: { email, password: "hunter2hunter2", name: "Dylan" },
    });
    expect(signUpResult.user.email).toBe(email);

    const signInResult = await auth.api.signInEmail({
      body: { email, password: "hunter2hunter2" },
    });
    expect(signInResult.user.email).toBe(email);
  });

  it("rejects sign-ups whose email is not in the allowlist", async () => {
    const { db } = createDb(databaseUrl);
    const allowedEmail = uniqueEmail();
    const auth = createAuth({ ...baseConfig, allowedSignupEmails: [allowedEmail] }, db);

    await expect(
      auth.api.signUpEmail({
        body: { email: uniqueEmail(), password: "hunter2hunter2", name: "Nope" },
      }),
    ).rejects.toMatchObject({ body: { message: "signup_restricted" } });

    const allowed = await auth.api.signUpEmail({
      body: { email: allowedEmail, password: "hunter2hunter2", name: "Allowed" },
    });
    expect(allowed.user.email).toBe(allowedEmail);
  });

  it("matches allowlist entries case-insensitively", async () => {
    const { db } = createDb(databaseUrl);
    const local = randomUUID();
    const auth = createAuth({ ...baseConfig, allowedSignupEmails: [`Ada.${local}@X.com`] }, db);

    const allowed = await auth.api.signUpEmail({
      body: { email: `ada.${local}@x.com`, password: "hunter2hunter2", name: "Ada" },
    });
    expect(allowed.user.email).toBe(`ada.${local}@x.com`);
  });

  it("completes the device authorization flow end to end", async () => {
    const { db } = createDb(databaseUrl);
    const auth = createAuth(baseConfig, db);
    const email = uniqueEmail();

    await auth.api.signUpEmail({
      body: { email, password: "hunter2hunter2", name: "Dylan" },
    });
    const { headers: signInHeaders } = await auth.api.signInEmail({
      body: { email, password: "hunter2hunter2" },
      returnHeaders: true,
    });
    const sessionCookie = signInHeaders.get("set-cookie")?.split(";")[0] ?? "";
    expect(sessionCookie).not.toBe("");

    const deviceCodeResult = await auth.api.deviceCode({
      body: { client_id: "synara-cli" },
    });
    expect(deviceCodeResult.user_code).toBeTruthy();
    expect(deviceCodeResult.device_code).toBeTruthy();

    // The device code must be claimed by a signed-in session (via the
    // verification GET endpoint) before it can be approved or denied.
    await auth.api.deviceVerify({
      query: { user_code: deviceCodeResult.user_code },
      headers: new Headers({ cookie: sessionCookie }),
    });

    const approveResult = await auth.api.deviceApprove({
      body: { userCode: deviceCodeResult.user_code },
      headers: new Headers({ cookie: sessionCookie }),
    });
    expect(approveResult.success).toBe(true);

    const tokenResult = await auth.api.deviceToken({
      body: {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCodeResult.device_code,
        client_id: "synara-cli",
      },
    });
    expect(tokenResult.access_token).toBeTruthy();
  });

  it("exposes at least one JWKS key", async () => {
    const { db } = createDb(databaseUrl);
    const auth = createAuth(baseConfig, db);

    const jwks = await auth.api.getJwks();
    expect(jwks.keys.length).toBeGreaterThanOrEqual(1);
  });
});
