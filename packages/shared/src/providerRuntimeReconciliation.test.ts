import { describe, expect, it } from "vitest";

import {
  isProviderRuntimeReconciliationAction,
  providerRuntimeReconciliationIdentityKey,
  type ProviderRuntimeReconciliationAction,
} from "./providerRuntimeReconciliation";

describe("providerRuntimeReconciliationIdentityKey", () => {
  it("uses one identity for settlement refinements of the same stale turn", () => {
    const actions: ReadonlyArray<ProviderRuntimeReconciliationAction> = [
      "settle-interrupted",
      "settle-terminal-projection",
      "settle-error",
    ];
    const keys = actions.map((action) =>
      providerRuntimeReconciliationIdentityKey(
        {
          provider: "codex",
          action,
          projectedTurnId: "turn-stale",
          runtimeTurnId: null,
        },
        ["thread-owner"],
      ),
    );

    expect(new Set(keys).size).toBe(1);
  });

  it("keeps scopes, projected turns, and runtime realignments distinct", () => {
    const settlement = (threadId: string, projectedTurnId: string) =>
      providerRuntimeReconciliationIdentityKey(
        {
          provider: "codex",
          action: "settle-interrupted",
          projectedTurnId,
          runtimeTurnId: null,
        },
        [threadId],
      );
    const realignment = (runtimeTurnId: string) =>
      providerRuntimeReconciliationIdentityKey({
        provider: "codex",
        action: "align-running-turn",
        projectedTurnId: "turn-stale",
        runtimeTurnId,
      });

    expect(
      new Set([
        settlement("thread-a", "turn-a"),
        settlement("thread-a", "turn-b"),
        settlement("thread-b", "turn-a"),
        realignment("turn-live-a"),
        realignment("turn-live-b"),
      ]).size,
    ).toBe(5);
  });
});

describe("isProviderRuntimeReconciliationAction", () => {
  it("accepts every supported action and rejects unknown values", () => {
    expect(isProviderRuntimeReconciliationAction("align-running-turn")).toBe(true);
    expect(isProviderRuntimeReconciliationAction("settle-interrupted")).toBe(true);
    expect(isProviderRuntimeReconciliationAction("settle-terminal-projection")).toBe(true);
    expect(isProviderRuntimeReconciliationAction("settle-error")).toBe(true);
    expect(isProviderRuntimeReconciliationAction("settle-retried")).toBe(false);
  });
});
