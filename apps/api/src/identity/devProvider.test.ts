import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiConfigError, assertDevIdentityAllowed, loadApiConfig } from "../config";
import { createDevIdentityProvider } from "./devProvider";

const devEnv = {
  IDENTITY_PROVIDER: "dev",
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  ACCOUNT_BASE_URL: "http://localhost:8788",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the dev identity safety gate", () => {
  it("refuses to start with NODE_ENV=production", () => {
    expect(() => loadApiConfig({ ...devEnv, NODE_ENV: "production" })).toThrow(ApiConfigError);
    expect(() => loadApiConfig({ ...devEnv, NODE_ENV: "production" })).toThrow(/production/);
  });

  it("refuses to start while WORKOS_API_KEY is set", () => {
    expect(() => loadApiConfig({ ...devEnv, WORKOS_API_KEY: "sk_live_real" })).toThrow(
      ApiConfigError,
    );
    expect(() => loadApiConfig({ ...devEnv, WORKOS_API_KEY: "sk_live_real" })).toThrow(
      /WORKOS_API_KEY/,
    );
  });

  // The gate is re-checked inside the provider factory itself, so a config
  // object built by hand — bypassing loadApiConfig — still cannot start it.
  it("is enforced by the provider factory, not only by config loading", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(createDevIdentityProvider()).rejects.toThrow(ApiConfigError);
  });

  it("is a plain predicate over the environment", () => {
    expect(() => assertDevIdentityAllowed({})).not.toThrow();
    expect(() => assertDevIdentityAllowed({ NODE_ENV: "production" })).toThrow(ApiConfigError);
    expect(() => assertDevIdentityAllowed({ WORKOS_API_KEY: "sk_x" })).toThrow(ApiConfigError);
  });

  it("parses a dev config without any WorkOS variables", () => {
    expect(loadApiConfig(devEnv)).toMatchObject({
      identityProvider: "dev",
      databaseUrl: devEnv.DATABASE_URL,
      baseUrl: devEnv.ACCOUNT_BASE_URL,
    });
  });

  it("rejects an unknown IDENTITY_PROVIDER value", () => {
    expect(() => loadApiConfig({ ...devEnv, IDENTITY_PROVIDER: "betterauth" })).toThrow(
      /IDENTITY_PROVIDER/,
    );
  });
});

describe("createDevIdentityProvider", () => {
  it("signs a user in with the OTP code it printed to stdout", async () => {
    // WORKOS_API_KEY may legitimately be set in the shell running this suite;
    // the dev provider must still be constructible for its own test.
    vi.stubEnv("WORKOS_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");

    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: unknown) => {
      logged.push(String(line));
    });
    const provider = await createDevIdentityProvider();
    try {
      const email = "offline@example.com";
      const challenge = await provider.verifier.createOtpChallenge({ email });
      expect(challenge.email).toBe(email);

      // The one place the code exists is the stdout line — exactly the
      // deliberate, gated exception the dev provider makes to the no-leak
      // rules. Read it back the way a contributor would.
      const line = logged.find((entry) => entry.includes(`[dev-identity] OTP for ${email}`));
      expect(line).toBeTruthy();
      const code = /(\d{6})$/.exec(line as string)?.[1] as string;
      expect(code).toMatch(/^\d{6}$/);

      const tokens = await provider.verifier.authenticateWithOtp({ email, code });
      expect(tokens.user.email).toBe(email);

      // The minted token verifies against the same provider — the full loop
      // a signed-in client performs, with no network beyond localhost.
      const session = await provider.verifier.verifyAccessToken(tokens.accessToken);
      expect(session.userId).toBe(tokens.user.id);

      // And the grant issuer provisions a personal workspace for it, like the
      // hosted provider would.
      const scope = await provider.grants.resolveEnvironmentScope(session, email);
      expect(scope.kind).toBe("selection_required");
      if (scope.kind === "selection_required") {
        expect(scope.organizations).toHaveLength(1);
      }
    } finally {
      spy.mockRestore();
      await provider.close();
    }
  });

  // Polling is proxied through the seam, so the dev provider must serve the
  // WHOLE device flow locally: issue the code, self-approve, grant on poll.
  it("completes the SSO device flow end to end, offline", async () => {
    vi.stubEnv("WORKOS_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");

    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const provider = await createDevIdentityProvider();
    try {
      const device = await provider.verifier.requestDeviceAuthorization();
      expect(device.deviceCode).toBeTruthy();

      // Immediately after issuance the human has "not clicked yet".
      const first = await provider.verifier.pollDeviceToken({ deviceCode: device.deviceCode });
      expect(first.status).toBe("pending");

      // The self-approval timer fires after DEVICE_APPROVE_DELAY_MS; poll
      // until it does, bounded well below the test timeout.
      let granted: Awaited<ReturnType<typeof provider.verifier.pollDeviceToken>> | undefined;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const poll = await provider.verifier.pollDeviceToken({ deviceCode: device.deviceCode });
        if (poll.status === "granted") {
          granted = poll;
          break;
        }
        expect(poll.status).toBe("pending");
      }
      if (!granted || granted.status !== "granted") {
        throw new Error("device authorization never self-approved");
      }

      const session = await provider.verifier.verifyAccessToken(granted.tokens.accessToken);
      expect(session.userId).toBe(granted.tokens.user.id);
    } finally {
      spy.mockRestore();
      await provider.close();
    }
  }, 15_000);
});
