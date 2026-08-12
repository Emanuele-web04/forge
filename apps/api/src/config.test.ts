import { describe, expect, it } from "vitest";
import { ApiConfigError, loadApiConfig, type WorkosApiConfig } from "./config";

/** The default (WorkOS) shape, narrowed so field assertions typecheck. */
function loadWorkosConfig(env: Record<string, string | undefined>): WorkosApiConfig {
  const config = loadApiConfig(env);
  if (config.identityProvider !== "workos") throw new Error("expected the workos provider");
  return config;
}

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
    expect(loadWorkosConfig(base).workosApiUrl).toBe("https://api.workos.com");
  });

  it("accepts an overridden API url", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_API_URL: "http://127.0.0.1:4010" });
    expect(config.workosApiUrl).toBe("http://127.0.0.1:4010");
  });

  // Both are resolved from WorkOS's OIDC metadata at verification time, not
  // guessed here. A hand-derived issuer was wrong for every real token: WorkOS
  // scopes `iss` to the environment's client id, which is not WORKOS_CLIENT_ID.
  it("leaves the issuer and JWKS url unset so they are discovered", () => {
    const config = loadWorkosConfig(base);
    expect(config.workosIssuer).toBeUndefined();
    expect(config.workosJwksUrl).toBeUndefined();
  });

  it("accepts a full JWKS url override", () => {
    const config = loadWorkosConfig({
      ...base,
      WORKOS_JWKS_URL: "http://127.0.0.1:4011/keys.json",
    });
    expect(config.workosJwksUrl).toBe("http://127.0.0.1:4011/keys.json");
  });

  // A custom auth domain changes `iss` to that domain, so it must be settable
  // independently of what discovery reports.
  it("accepts an explicit issuer override for a custom auth domain", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_ISSUER: "https://auth.example.com" });
    expect(config.workosIssuer).toBe("https://auth.example.com");
  });

  // The no-proxy default: a direct/Docker self-host must not trust a header
  // any caller can forge. Proxied deployments (Railway) opt in with 1.
  it("defaults trusted proxy hops to zero and honours an explicit value", () => {
    expect(loadApiConfig(base).trustedProxyHops).toBe(0);
    expect(loadApiConfig({ ...base, TRUSTED_PROXY_HOPS: "1" }).trustedProxyHops).toBe(1);
  });

  it("leaves the profile proxy secret unset by default and reads a configured one", () => {
    expect(loadApiConfig(base).profileProxySecret).toBeUndefined();
    expect(loadApiConfig({ ...base, PROFILE_PROXY_SECRET: "" }).profileProxySecret).toBeUndefined();
    expect(loadApiConfig({ ...base, PROFILE_PROXY_SECRET: "s3cret" }).profileProxySecret).toBe(
      "s3cret",
    );
  });

  it("ignores a trailing slash on the API url so derived paths stay single-slashed", () => {
    const config = loadWorkosConfig({ ...base, WORKOS_API_URL: "https://api.workos.com/" });
    expect(config.workosApiUrl).toBe("https://api.workos.com");
  });
});
