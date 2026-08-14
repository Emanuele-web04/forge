// FILE: enrollment.test.ts
// Purpose: The consent decision (ADR 0002/0015) and the device-code field's
//          normalization, which is the only thing standing between a mistyped
//          O/0 and a burnt approval attempt.
// Layer: Web remote-access feature tests.

import type { AccountHost, EnvironmentId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { RemoteHostEnrollment } from "./api";
import {
  DEVICE_USER_CODE_LENGTH,
  formatDeviceUserCode,
  isCompleteDeviceUserCode,
  normalizeDeviceUserCode,
  shouldPromptForDiscoverability,
} from "./enrollment";

function makeHost(overrides: Partial<AccountHost> = {}): AccountHost {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    environmentId: "env_1" as EnvironmentId,
    name: "Ada's MacBook",
    platform: "darwin",
    kind: "local",
    endpoints: [],
    ownerUserId: "user_1",
    discoverable: true,
    linked: true,
    keyGeneration: 1,
    mine: true,
    createdAt: "2026-08-13T10:00:00.000Z",
    lastSeenAt: "2026-08-13T10:00:00.000Z",
    ...overrides,
  };
}

function makeEnrollment(overrides: Partial<RemoteHostEnrollment> = {}): RemoteHostEnrollment {
  return {
    host: makeHost(),
    organizationMemberCount: 1,
    discoverabilityAcknowledged: false,
    ...overrides,
  };
}

describe("shouldPromptForDiscoverability", () => {
  it("prompts in a multi-member org before the host becomes discoverable", () => {
    const decision = shouldPromptForDiscoverability(makeEnrollment({ organizationMemberCount: 4 }));

    expect(decision).toEqual({ prompt: true });
  });

  // The whole point of ADR 0002's guard: a solo user must never see a modal
  // asking them to share a machine with a workspace of one.
  it("never prompts in a personal org", () => {
    const decision = shouldPromptForDiscoverability(makeEnrollment({ organizationMemberCount: 1 }));

    expect(decision).toEqual({ prompt: false, reason: "personal-org" });
  });

  it("treats an empty workspace the same as a personal one", () => {
    expect(shouldPromptForDiscoverability(makeEnrollment({ organizationMemberCount: 0 }))).toEqual({
      prompt: false,
      reason: "personal-org",
    });
  });

  it("does not re-ask once the owner has answered", () => {
    const decision = shouldPromptForDiscoverability(
      makeEnrollment({ organizationMemberCount: 9, discoverabilityAcknowledged: true }),
    );

    expect(decision).toEqual({ prompt: false, reason: "already-acknowledged" });
  });

  it("does not prompt when there is no locally registered host", () => {
    expect(shouldPromptForDiscoverability(makeEnrollment({ host: null }))).toEqual({
      prompt: false,
      reason: "no-host",
    });
    expect(shouldPromptForDiscoverability(null)).toEqual({ prompt: false, reason: "no-host" });
    expect(shouldPromptForDiscoverability(undefined)).toEqual({ prompt: false, reason: "no-host" });
  });

  // An identity-provider hiccup must not manufacture a sharing prompt: the
  // prompt is the affirmative step toward org-wide code execution.
  it("does not prompt when the member count is unavailable", () => {
    expect(
      shouldPromptForDiscoverability(makeEnrollment({ organizationMemberCount: null })),
    ).toEqual({ prompt: false, reason: "unknown-membership" });
    expect(
      shouldPromptForDiscoverability(makeEnrollment({ organizationMemberCount: Number.NaN })),
    ).toEqual({ prompt: false, reason: "unknown-membership" });
  });
});

describe("normalizeDeviceUserCode", () => {
  it("uppercases lowercase input", () => {
    expect(normalizeDeviceUserCode("abcdefgh")).toBe("ABCDEFGH");
  });

  it("accepts a code typed in mixed case", () => {
    expect(normalizeDeviceUserCode("AbCd23Gh")).toBe("ABCD23GH");
  });

  // I/O/0/1 are absent from the alphabet exactly because they are the
  // characters a person mistypes reading a code off another screen. Dropping
  // them is visible in the field; accepting them would fail server-side and
  // spend a rate-limited approval attempt.
  it("rejects the ambiguous characters the alphabet excludes", () => {
    expect(normalizeDeviceUserCode("IO01")).toBe("");
    expect(normalizeDeviceUserCode("io01")).toBe("");
    expect(normalizeDeviceUserCode("A1B0C")).toBe("ABC");
  });

  it("drops separators so the displayed form can be pasted back", () => {
    expect(normalizeDeviceUserCode("ABCD-EFGH")).toBe("ABCDEFGH");
    expect(normalizeDeviceUserCode(" abcd efgh ")).toBe("ABCDEFGH");
  });

  it("stops at the code length rather than accumulating overflow", () => {
    expect(normalizeDeviceUserCode("ABCDEFGHJKLM")).toBe("ABCDEFGH");
    expect(normalizeDeviceUserCode("ABCDEFGHJKLM")).toHaveLength(DEVICE_USER_CODE_LENGTH);
  });

  it("keeps digits that are in the alphabet", () => {
    expect(normalizeDeviceUserCode("23456789")).toBe("23456789");
  });

  it("is idempotent", () => {
    const once = normalizeDeviceUserCode("ab-cd-23-gh");
    expect(normalizeDeviceUserCode(once)).toBe(once);
  });
});

describe("formatDeviceUserCode", () => {
  it("groups a complete code for reading aloud", () => {
    expect(formatDeviceUserCode("ABCDEFGH")).toBe("ABCD-EFGH");
  });

  it("leaves a short code ungrouped", () => {
    expect(formatDeviceUserCode("ABC")).toBe("ABC");
    expect(formatDeviceUserCode("ABCD")).toBe("ABCD");
  });

  it("groups partial input past the first group", () => {
    expect(formatDeviceUserCode("ABCDE")).toBe("ABCD-E");
  });
});

describe("isCompleteDeviceUserCode", () => {
  it("is true only at the full code length", () => {
    expect(isCompleteDeviceUserCode("ABCDEFGH")).toBe(true);
    expect(isCompleteDeviceUserCode("ABCDEFG")).toBe(false);
    expect(isCompleteDeviceUserCode("")).toBe(false);
  });
});
