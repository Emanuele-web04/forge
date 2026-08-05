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

  it("defaults the WorkOS API url and derives JWKS from the client id", () => {
    const config = loadApiConfig(base);
    expect(config.workosApiUrl).toBe("https://api.workos.com");
    expect(config.workosJwksUrl).toBe("https://api.workos.com/sso/jwks/client_123");
  });

  it("derives JWKS from an overridden API url", () => {
    const config = loadApiConfig({ ...base, WORKOS_API_URL: "http://127.0.0.1:4010" });
    expect(config.workosApiUrl).toBe("http://127.0.0.1:4010");
    expect(config.workosJwksUrl).toBe("http://127.0.0.1:4010/sso/jwks/client_123");
  });

  it("accepts a full JWKS url override", () => {
    const config = loadApiConfig({ ...base, WORKOS_JWKS_URL: "http://127.0.0.1:4011/keys.json" });
    expect(config.workosJwksUrl).toBe("http://127.0.0.1:4011/keys.json");
  });

  it("ignores a trailing slash on the API url so derived paths stay single-slashed", () => {
    const config = loadApiConfig({ ...base, WORKOS_API_URL: "https://api.workos.com/" });
    expect(config.workosApiUrl).toBe("https://api.workos.com");
    expect(config.workosJwksUrl).toBe("https://api.workos.com/sso/jwks/client_123");
  });
});
