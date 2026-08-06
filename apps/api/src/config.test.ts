import { describe, expect, it } from "vitest";
import { ApiConfigError, loadApiConfig } from "./config";

const base = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  WORKOS_API_KEY: "sk_test_123",
  WORKOS_CLIENT_ID: "client_123",
  ACCOUNT_BASE_URL: "https://accounts.example.com",
};

describe("loadApiConfig", () => {
  it("throws listing every missing required var", () => {
    expect(() => loadApiConfig({})).toThrow(ApiConfigError);
    expect(() => loadApiConfig({})).toThrow(
      /DATABASE_URL.*WORKOS_API_KEY.*WORKOS_CLIENT_ID.*ACCOUNT_BASE_URL/s,
    );
  });

  it("reads the required vars", () => {
    expect(loadApiConfig(base)).toMatchObject({
      databaseUrl: base.DATABASE_URL,
      workosApiKey: base.WORKOS_API_KEY,
      workosClientId: base.WORKOS_CLIENT_ID,
      baseUrl: base.ACCOUNT_BASE_URL,
    });
  });

  it("defaults port to 8788 and parses PORT", () => {
    expect(loadApiConfig(base).port).toBe(8788);
    expect(loadApiConfig({ ...base, PORT: "9000" }).port).toBe(9000);
  });

  it("defaults the WorkOS API url", () => {
    expect(loadApiConfig(base).workosApiUrl).toBe("https://api.workos.com");
  });

  it("accepts an overridden API url", () => {
    const config = loadApiConfig({ ...base, WORKOS_API_URL: "http://127.0.0.1:4010" });
    expect(config.workosApiUrl).toBe("http://127.0.0.1:4010");
  });

  // Both are resolved from WorkOS's OIDC metadata at verification time, not
  // guessed here. A hand-derived issuer was wrong for every real token: WorkOS
  // scopes `iss` to the environment's client id, which is not WORKOS_CLIENT_ID.
  it("leaves the issuer and JWKS url unset so they are discovered", () => {
    const config = loadApiConfig(base);
    expect(config.workosIssuer).toBeUndefined();
    expect(config.workosJwksUrl).toBeUndefined();
  });

  it("accepts a full JWKS url override", () => {
    const config = loadApiConfig({ ...base, WORKOS_JWKS_URL: "http://127.0.0.1:4011/keys.json" });
    expect(config.workosJwksUrl).toBe("http://127.0.0.1:4011/keys.json");
  });

  // A custom auth domain changes `iss` to that domain, so it must be settable
  // independently of what discovery reports.
  it("accepts an explicit issuer override for a custom auth domain", () => {
    const config = loadApiConfig({ ...base, WORKOS_ISSUER: "https://auth.example.com" });
    expect(config.workosIssuer).toBe("https://auth.example.com");
  });

  it("ignores a trailing slash on the API url so derived paths stay single-slashed", () => {
    const config = loadApiConfig({ ...base, WORKOS_API_URL: "https://api.workos.com/" });
    expect(config.workosApiUrl).toBe("https://api.workos.com");
  });
});
