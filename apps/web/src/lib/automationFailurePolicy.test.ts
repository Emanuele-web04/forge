// FILE: automationFailurePolicy.test.ts
// Purpose: Locks down the failure-policy vocabulary shared by the dialog and detail page.
// Layer: Web lib test
// Depends on: automationFailurePolicy converters and option builder.

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_FAILURE_POLICY_NEVER,
  DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE,
  automationFailurePolicyOptions,
  automationFailurePolicyValue,
  stopAfterConsecutiveFailuresFromPolicyValue,
} from "./automationFailurePolicy";

describe("automation failure policy values", () => {
  it("defaults to the contract's threshold of three", () => {
    expect(DEFAULT_AUTOMATION_FAILURE_POLICY_VALUE).toBe("3");
  });

  it("maps a stored threshold to its UI value and back", () => {
    expect(automationFailurePolicyValue(null)).toBe(AUTOMATION_FAILURE_POLICY_NEVER);
    expect(automationFailurePolicyValue(1)).toBe("1");
    expect(automationFailurePolicyValue(7)).toBe("7");

    expect(stopAfterConsecutiveFailuresFromPolicyValue(AUTOMATION_FAILURE_POLICY_NEVER)).toBeNull();
    expect(stopAfterConsecutiveFailuresFromPolicyValue("1")).toBe(1);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("7")).toBe(7);
  });

  it("round-trips every stored threshold through the UI value", () => {
    for (const stored of [null, 1, 3, 5, 12]) {
      expect(
        stopAfterConsecutiveFailuresFromPolicyValue(automationFailurePolicyValue(stored)),
      ).toBe(stored);
    }
  });

  it("falls back to the default threshold for unparseable UI values", () => {
    expect(stopAfterConsecutiveFailuresFromPolicyValue("")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("abc")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("0")).toBe(3);
    expect(stopAfterConsecutiveFailuresFromPolicyValue("-2")).toBe(3);
  });
});

describe("automationFailurePolicyOptions", () => {
  it("offers the preset thresholds then never, with singular/plural labels", () => {
    expect(automationFailurePolicyOptions("3")).toEqual([
      { value: "1", label: "Stop after 1 failure" },
      { value: "3", label: "Stop after 3 failures" },
      { value: "5", label: "Stop after 5 failures" },
      { value: "never", label: "Keep running" },
    ]);
  });

  it("does not prepend when the current value is a preset or never", () => {
    expect(automationFailurePolicyOptions("never").map((option) => option.value)).toEqual([
      "1",
      "3",
      "5",
      "never",
    ]);
  });

  it("prepends a non-preset stored threshold so it renders as itself", () => {
    expect(automationFailurePolicyOptions("7")).toEqual([
      { value: "7", label: "Stop after 7 failures" },
      { value: "1", label: "Stop after 1 failure" },
      { value: "3", label: "Stop after 3 failures" },
      { value: "5", label: "Stop after 5 failures" },
      { value: "never", label: "Keep running" },
    ]);
  });
});
