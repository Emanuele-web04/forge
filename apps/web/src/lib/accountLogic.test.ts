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
  isSignInCancellation,
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
  it("shows the message of a classified account error", () => {
    // A WsRpcError as it crosses the wire: tagged, message we wrote.
    expect(
      accountErrorMessage(
        Object.assign(new Error("That handle is already taken"), {
          _tag: "WsRpcError",
          code: "handle_taken",
        }),
        "fallback",
      ),
    ).toBe("That handle is already taken");
    // Bare code without the tag still qualifies — the code is ours.
    expect(
      accountErrorMessage(
        Object.assign(new Error("That code didn't work — check it and try again"), {
          code: "invalid_verification_code",
        }),
        "fallback",
      ),
    ).toBe("That code didn't work — check it and try again");
    // The verification refusal keeps its message too.
    expect(
      accountErrorMessage(
        Object.assign(new Error("Enter the 6-digit code we sent to your email"), {
          _tag: "AccountEmailVerificationRequiredError",
        }),
        "fallback",
      ),
    ).toBe("Enter the 6-digit code we sent to your email");
  });

  // Raw runtime/transport internals must never become UI copy: this is the
  // guard that keeps "All fibers interrupted without error" out of a dialog.
  it("falls back for unclassified errors, runtime internals, and non-errors", () => {
    expect(accountErrorMessage(new Error("All fibers interrupted without error"), "fallback")).toBe(
      "fallback",
    );
    expect(accountErrorMessage(new Error("socket hang up"), "fallback")).toBe("fallback");
    expect(
      accountErrorMessage(
        Object.assign(new Error("interrupted"), { _tag: "InterruptedException" }),
        "fallback",
      ),
    ).toBe("fallback");
    // An unrecognized code is not ours to quote.
    expect(
      accountErrorMessage(
        Object.assign(new Error("weird upstream text"), { code: "not_a_real_code" }),
        "fallback",
      ),
    ).toBe("fallback");
    expect(accountErrorMessage(new Error("  "), "fallback")).toBe("fallback");
    expect(accountErrorMessage("not-an-error", "fallback")).toBe("fallback");
    expect(accountErrorMessage(null, "fallback")).toBe("fallback");
  });
});

describe("isSignInCancellation", () => {
  it("recognizes the transport's interrupted wrapper and Effect interruption tags", () => {
    expect(
      isSignInCancellation(
        Object.assign(new Error("WebSocket RPC account.completeSso was cancelled."), {
          _tag: "WsTransportRequestInterruptedError",
          code: "WS_REQUEST_ABORTED",
        }),
      ),
    ).toBe(true);
    expect(
      isSignInCancellation(Object.assign(new Error("interrupted"), { _tag: "Interrupted" })),
    ).toBe(true);
    expect(
      isSignInCancellation(
        Object.assign(new Error("interrupted"), { _tag: "InterruptedException" }),
      ),
    ).toBe(true);
    // The squashed runtime form seen rendered in the live bug.
    expect(isSignInCancellation(new Error("All fibers interrupted without error"))).toBe(true);
  });

  it("recognizes our own AbortController's raw rejection", () => {
    expect(isSignInCancellation(new DOMException("The operation was aborted.", "AbortError"))).toBe(
      true,
    );
  });

  it("does not treat real outcomes as cancellations", () => {
    expect(
      isSignInCancellation(
        Object.assign(new Error("That code didn't work"), {
          _tag: "WsRpcError",
          code: "invalid_verification_code",
        }),
      ),
    ).toBe(false);
    expect(isSignInCancellation(new Error("socket hang up"))).toBe(false);
    expect(isSignInCancellation("not-an-error")).toBe(false);
    expect(isSignInCancellation(null)).toBe(false);
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
