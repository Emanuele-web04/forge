// FILE: accountRpcErrors.test.ts
// Purpose: Locks down the account RPC error mapping — codes survive to the
// client, tryPromise wrapping is unwrapped, and the sensitive path never
// attaches a cause.

import { AccountEmailVerificationRequiredError, WsRpcError } from "@synara/contracts";
import { AccountApiError, EmailVerificationRequiredError } from "@synara/shared/account";
import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { toAccountWsRpcError, toSensitiveWsRpcError } from "./accountRpcErrors";

/** Narrows the sensitive mapping's union; everything but one case is a WsRpcError. */
function asWsRpcError(mapped: WsRpcError | AccountEmailVerificationRequiredError): WsRpcError {
  if (!(mapped instanceof WsRpcError)) throw new Error("expected a WsRpcError");
  return mapped;
}

const apiError = new AccountApiError({
  code: "handle_taken",
  status: 409,
  message: "That handle is already taken",
});

describe("toAccountWsRpcError", () => {
  it("carries the AccountErrorCode and message through to the client", () => {
    const mapped = toAccountWsRpcError(apiError, "fallback");
    expect(mapped.code).toBe("handle_taken");
    expect(mapped.message).toBe("That handle is already taken");
  });

  it("unwraps the UnknownError produced by Effect.tryPromise", () => {
    const mapped = toAccountWsRpcError(new Cause.UnknownError(apiError), "fallback");
    expect(mapped.code).toBe("handle_taken");
    expect(mapped.message).toBe("That handle is already taken");
  });

  it("keeps a plain error's message and falls back for the rest", () => {
    expect(toAccountWsRpcError(new Error("boom"), "fallback").message).toBe("boom");
    expect(toAccountWsRpcError("not-an-error", "fallback").message).toBe("fallback");
  });

  it("passes an existing WsRpcError through unchanged", () => {
    const original = new WsRpcError({ message: "already mapped", code: "rate_limited" });
    expect(toAccountWsRpcError(original, "fallback")).toBe(original);
  });
});

describe("toSensitiveWsRpcError", () => {
  it("keeps the account service's code and message but never a cause", () => {
    const mapped = asWsRpcError(
      toSensitiveWsRpcError(new Cause.UnknownError(apiError), "fallback"),
    );
    expect(mapped.code).toBe("handle_taken");
    expect(mapped.message).toBe("That handle is already taken");
    expect(mapped.cause).toBeUndefined();
  });

  it("reduces an unrecognized failure to the fallback message alone", () => {
    // A fetch error can quote the request body, which contained the code —
    // neither its message nor the object itself may survive.
    const leaky = new Error('fetch failed for body {"code":"654321"}');
    const mapped = asWsRpcError(toSensitiveWsRpcError(new Cause.UnknownError(leaky), "fallback"));
    expect(mapped.message).toBe("fallback");
    expect(mapped.cause).toBeUndefined();
    expect(JSON.stringify(mapped)).not.toContain("654321");
  });

  it("strips the cause from an already-mapped WsRpcError", () => {
    const original = new WsRpcError({
      message: "mapped",
      code: "invalid_verification_code",
      cause: new Error("carrier"),
    });
    const mapped = asWsRpcError(toSensitiveWsRpcError(original, "fallback"));
    expect(mapped.message).toBe("mapped");
    expect(mapped.code).toBe("invalid_verification_code");
    expect(mapped.cause).toBeUndefined();
  });

  // The one refusal that keeps a payload: the fields the in-app verification
  // step redeems cross the RPC boundary as their own tagged error.
  it("maps a verification-required refusal to the tagged error with its fields", () => {
    const refusal = new EmailVerificationRequiredError({
      message: "Enter the 6-digit code we sent to your email",
      pendingAuthenticationToken: "pat_123",
      email: "ada@example.com",
      emailVerificationId: "email_verification_123",
    });
    const mapped = toSensitiveWsRpcError(new Cause.UnknownError(refusal), "fallback");
    expect(mapped).toBeInstanceOf(AccountEmailVerificationRequiredError);
    expect(mapped).toMatchObject({
      pendingAuthenticationToken: "pat_123",
      email: "ada@example.com",
      emailVerificationId: "email_verification_123",
    });
  });
});
