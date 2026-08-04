import { describe, expect, it } from "vitest";
import { ApiConfigError, enabledAuthMethods, isSignupAllowed, loadApiConfig } from "./config";

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

describe("isSignupAllowed", () => {
  it("admits anyone when no allowlist is configured", () => {
    expect(isSignupAllowed(loadApiConfig(base), "anyone@x.com")).toBe(true);
  });
  it("compares case-insensitively in both directions", () => {
    const config = loadApiConfig({ ...base, ACCOUNT_ALLOWED_SIGNUP_EMAILS: "Ada@X.com" });
    expect(isSignupAllowed(config, "ada@x.com")).toBe(true);
    expect(isSignupAllowed(config, "ADA@X.COM")).toBe(true);
    expect(isSignupAllowed(config, "grace@x.com")).toBe(false);
  });
});

describe("enabledAuthMethods", () => {
  it("reports enabled socials, email delivery, and restriction", () => {
    const config = loadApiConfig({
      ...base,
      GITHUB_CLIENT_ID: "i",
      GITHUB_CLIENT_SECRET: "s",
      RESEND_API_KEY: "re_x",
      EMAIL_FROM: "noreply@example.com",
      ACCOUNT_ALLOWED_SIGNUP_EMAILS: "a@x.com",
    });
    expect(enabledAuthMethods(config)).toEqual({
      emailPassword: true,
      social: ["github"],
      emailDelivery: true,
      signupRestricted: true,
    });
  });
  it("reports no email delivery without a Resend key", () => {
    const config = loadApiConfig({ ...base, EMAIL_FROM: "noreply@example.com" });
    expect(enabledAuthMethods(config).emailDelivery).toBe(false);
  });
});
