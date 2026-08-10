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
  handleFormatError,
  publicProfileUrl,
  readAccountErrorCode,
  sanitizeHandleInput,
} from "./accountLogic";

function makeMe(overrides: Partial<AccountMe> = {}): AccountMe {
  return {
    id: "user_1",
    name: "Dylan Verbreyt",
    email: "dylan@example.com",
    organization: { id: "org_1", name: "Dylan's Workspace" },
    profile: null,
    ...overrides,
  };
}

describe("readAccountErrorCode", () => {
  it("reads the code off a WsRpcError-shaped failure", () => {
    expect(readAccountErrorCode({ message: "nope", code: "invalid_credentials" })).toBe(
      "invalid_credentials",
    );
  });

  it("returns null for errors without a code (socket loss, plain Error)", () => {
    expect(readAccountErrorCode(new Error("boom"))).toBeNull();
    expect(readAccountErrorCode(null)).toBeNull();
    expect(readAccountErrorCode({ message: "x", code: 42 })).toBeNull();
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
    expect(sanitizeHandleInput("@Dylan_Verbreyt!")).toBe("dylanverbreyt");
    expect(sanitizeHandleInput("my-handle")).toBe("my-handle");
  });

  it("caps at 30 characters", () => {
    expect(sanitizeHandleInput("a".repeat(40))).toHaveLength(30);
  });
});

describe("handleFormatError", () => {
  it("accepts handles the contracts schema accepts", () => {
    expect(handleFormatError("dylan")).toBeNull();
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
    expect(accountInitial("dylan")).toBe("D");
    expect(accountInitial("  ")).toBe("?");
  });

  it("prefers the profile display name for the footer's first name", () => {
    expect(accountFirstName(makeMe())).toBe("Dylan");
    expect(
      accountFirstName(
        makeMe({
          profile: { handle: "ada-l", displayName: "Ada Lovelace", avatarColor: "#22c55e" },
        }),
      ),
    ).toBe("Ada");
  });

  it("builds the public profile URL from the handle", () => {
    expect(publicProfileUrl("dylan")).toBe("https://trysynara.com/profile/@dylan");
  });
});
