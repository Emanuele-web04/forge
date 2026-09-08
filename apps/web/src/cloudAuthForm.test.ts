import { describe, expect, it } from "vitest";

import { passwordStrength, validateCloudAuthValues } from "./cloudAuthForm";

describe("validateCloudAuthValues", () => {
  it("requires an email, password, and accepted terms when creating an account", () => {
    expect(
      validateCloudAuthValues("signup", {
        email: "not-an-email",
        password: "short",
        acceptedTerms: false,
      }),
    ).toEqual({
      acceptedTerms: "Accept the terms to create your account.",
      email: "Enter a valid email address.",
      password: "Use at least 8 characters.",
    });
  });

  it("does not require terms for an existing account", () => {
    expect(
      validateCloudAuthValues("login", {
        email: "developer@example.com",
        password: "correct horse battery staple",
        acceptedTerms: false,
      }),
    ).toEqual({});
  });
});

describe("passwordStrength", () => {
  it("keeps the strength indicator deterministic", () => {
    expect(passwordStrength("")).toBe("empty");
    expect(passwordStrength("password")).toBe("weak");
    expect(passwordStrength("Password1")).toBe("fair");
    expect(passwordStrength("Password1!secure")).toBe("strong");
  });
});
