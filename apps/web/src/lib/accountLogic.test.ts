// FILE: accountLogic.test.ts
// Purpose: Locks down the pure account UI helpers — error-code classification,
// handle sanitizing/validation, and display derivations.
// Layer: Web account feature unit tests.

import type { AccountMe } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  accountErrorMessage,
  accountFirstName,
  accountInitial,
  formatResendCountdown,
  handleFormatError,
  publicProfileUrl,
  readAccountErrorCode,
  readEmailVerificationChallenge,
  sanitizeHandleInput,
  sanitizeVerificationCodeInput,
} from "./accountLogic";

function makeMe(overrides: Partial<AccountMe> = {}): AccountMe {
  return {
    id: "user_1",
    name: "Ada Lovelace",
    email: "ada@example.com",
    organization: { id: "org_1", name: "Ada's Workspace" },
    profile: null,
    ...overrides,
  };
}

describe("readAccountErrorCode", () => {
  it("reads the code off a WsRpcError-shaped failure", () => {
    expect(readAccountErrorCode({ message: "nope", code: "invalid_verification_code" })).toBe(
      "invalid_verification_code",
    );
  });

  it("returns null for errors without a code (socket loss, plain Error)", () => {
    expect(readAccountErrorCode(new Error("boom"))).toBeNull();
    expect(readAccountErrorCode(null)).toBeNull();
    expect(readAccountErrorCode({ message: "x", code: 42 })).toBeNull();
  });
});

describe("readEmailVerificationChallenge", () => {
  const fields = {
    pendingAuthenticationToken: "pat_123",
    email: "ada@example.com",
    emailVerificationId: "email_verification_123",
  };

  it("reads the challenge off the server's tagged RPC error", () => {
    expect(
      readEmailVerificationChallenge({
        _tag: "AccountEmailVerificationRequiredError",
        message: "Enter the code",
        ...fields,
      }),
    ).toEqual(fields);
  });

  it("returns null for anything without the tag or the full field set", () => {
    // A bare code with no payload cannot be completed in-app.
    expect(
      readEmailVerificationChallenge({ message: "x", code: "email_verification_required" }),
    ).toBeNull();
    expect(
      readEmailVerificationChallenge({
        _tag: "AccountEmailVerificationRequiredError",
        message: "x",
        email: "ada@example.com",
      }),
    ).toBeNull();
    expect(readEmailVerificationChallenge(new Error("boom"))).toBeNull();
    expect(readEmailVerificationChallenge(null)).toBeNull();
  });
});

describe("sanitizeVerificationCodeInput", () => {
  it("keeps digits only and caps at the code length", () => {
    expect(sanitizeVerificationCodeInput("123456")).toBe("123456");
    expect(sanitizeVerificationCodeInput("12 34 56")).toBe("123456");
    expect(sanitizeVerificationCodeInput("code: 987654!")).toBe("987654");
    expect(sanitizeVerificationCodeInput("12345678")).toBe("123456");
    expect(sanitizeVerificationCodeInput("abc")).toBe("");
  });
});

describe("formatResendCountdown", () => {
  it("formats m:ss, rounding partial seconds up", () => {
    expect(formatResendCountdown(47)).toBe("0:47");
    expect(formatResendCountdown(60)).toBe("1:00");
    expect(formatResendCountdown(59.2)).toBe("1:00");
    expect(formatResendCountdown(5)).toBe("0:05");
    expect(formatResendCountdown(0)).toBe("0:00");
    expect(formatResendCountdown(-3)).toBe("0:00");
  });
});

describe("accountErrorMessage", () => {
  it("prefers the error's own message and falls back for empty ones", () => {
    expect(accountErrorMessage(new Error("Handle taken"), "fallback")).toBe("Handle taken");
    expect(accountErrorMessage(new Error("  "), "fallback")).toBe("fallback");
    expect(accountErrorMessage("not-an-error", "fallback")).toBe("fallback");
  });
});

describe("sanitizeHandleInput", () => {
  it("strips the @-prefix, uppercases, and disallowed characters", () => {
    expect(sanitizeHandleInput("@Ada_Lovelace!")).toBe("adalovelace");
    expect(sanitizeHandleInput("my-handle")).toBe("my-handle");
  });

  it("caps at 30 characters", () => {
    expect(sanitizeHandleInput("a".repeat(40))).toHaveLength(30);
  });
});

describe("handleFormatError", () => {
  it("accepts handles the contracts schema accepts", () => {
    expect(handleFormatError("ada")).toBeNull();
    expect(handleFormatError("a-1")).toBeNull();
  });

  it("mirrors the schema's rejections", () => {
    expect(handleFormatError("")).not.toBeNull();
    expect(handleFormatError("ab")).not.toBeNull();
    expect(handleFormatError("-abc")).not.toBeNull();
    expect(handleFormatError("abc-")).not.toBeNull();
  });
});

describe("display derivations", () => {
  it("derives the avatar initial from the display name", () => {
    expect(accountInitial("ada")).toBe("A");
    expect(accountInitial("  ")).toBe("?");
  });

  it("prefers the profile display name for the footer's first name", () => {
    expect(accountFirstName(makeMe())).toBe("Ada");
    expect(
      accountFirstName(
        makeMe({
          profile: { handle: "grace-h", displayName: "Grace Hopper", avatarColor: "#22c55e" },
        }),
      ),
    ).toBe("Grace");
  });

  it("builds the public profile URL from the handle", () => {
    expect(publicProfileUrl("ada")).toBe("https://trysynara.com/profile/@ada");
  });
});
