import { describe, expect, it } from "vitest";

import {
  classifyRemotePosture,
  evaluateUpgradeGate,
  type UpgradeGateInput,
} from "./remoteUpgradePolicy";

describe("classifyRemotePosture", () => {
  it("is operational when major.minor line up, even across patch releases", () => {
    expect(
      classifyRemotePosture({
        brokerBuild: "0.6.3",
        remoteBuild: "0.6.9",
        drain: { activeTurnCount: 3 },
      }),
    ).toBe("operational");
  });

  // The RFC's headline rule: skew + active turns is read-degraded, not a kill.
  it("is read-degraded-active when the remote is older and turns are running", () => {
    expect(
      classifyRemotePosture({
        brokerBuild: "0.7.0",
        remoteBuild: "0.6.3",
        drain: { activeTurnCount: 1 },
      }),
    ).toBe("read-degraded-active");
  });

  it("is read-degraded-idle when the remote is older and nothing is running", () => {
    expect(
      classifyRemotePosture({
        brokerBuild: "0.7.0",
        remoteBuild: "0.6.3",
        drain: { activeTurnCount: 0 },
      }),
    ).toBe("read-degraded-idle");
  });

  it("also degrades when the remote is NEWER than the broker", () => {
    expect(
      classifyRemotePosture({
        brokerBuild: "0.6.3",
        remoteBuild: "0.7.0",
        drain: { activeTurnCount: 0 },
      }),
    ).toBe("read-degraded-idle");
  });

  // Mutation guard: an unknown build must fail safe to degraded. Treating it as
  // compatible would let a mystery server take writes.
  it.each([
    ["an unknown remote build", { brokerBuild: "0.6.3", remoteBuild: undefined }],
    ["an unknown broker build", { brokerBuild: undefined, remoteBuild: "0.6.3" }],
    ["a garbage remote build", { brokerBuild: "0.6.3", remoteBuild: "not-a-version" }],
  ])("degrades on %s", (_label, builds) => {
    expect(classifyRemotePosture({ ...builds, drain: { activeTurnCount: 0 } })).toBe(
      "read-degraded-idle",
    );
  });
});

function gate(overrides: Partial<UpgradeGateInput> = {}): UpgradeGateInput {
  return {
    currentReleaseId: "0.6.3",
    targetReleaseId: "0.7.0",
    userInvoked: true,
    drain: { activeTurnCount: 0 },
    elapsedDrainMs: 0,
    drainTimeoutMs: 300_000,
    ...overrides,
  };
}

describe("evaluateUpgradeGate", () => {
  it("swaps when the user asked and nothing is in flight", () => {
    expect(evaluateUpgradeGate(gate())).toEqual({ decision: "swap" });
  });

  // Mutation guard: dropping the userInvoked check turns weekly releases into
  // an automatic restart that kills long-running work.
  it("refuses an upgrade nobody asked for", () => {
    const verdict = evaluateUpgradeGate(gate({ userInvoked: false }));
    expect(verdict.decision).toBe("refused");
    expect(verdict.decision === "refused" && verdict.reason).toMatch(/user-invoked/);
  });

  it("refuses an un-asked-for upgrade even when idle and out of date", () => {
    expect(
      evaluateUpgradeGate(gate({ userInvoked: false, drain: { activeTurnCount: 0 } })).decision,
    ).toBe("refused");
  });

  it("does nothing when the target release is already active", () => {
    expect(evaluateUpgradeGate(gate({ targetReleaseId: "0.6.3" }))).toEqual({
      decision: "already-current",
    });
  });

  // Mutation guard: removing the drain check would swap the release out from
  // under a streaming turn.
  it("waits while a turn is still active and the deadline has not passed", () => {
    expect(
      evaluateUpgradeGate(gate({ drain: { activeTurnCount: 2 }, elapsedDrainMs: 1000 })),
    ).toEqual({ decision: "wait", activeTurnCount: 2 });
  });

  it("reports a drain timeout instead of forcing the swap itself", () => {
    expect(
      evaluateUpgradeGate(
        gate({ drain: { activeTurnCount: 1 }, elapsedDrainMs: 300_000, drainTimeoutMs: 300_000 }),
      ),
    ).toEqual({ decision: "drain-timeout", activeTurnCount: 1 });
  });

  it("never returns swap while any turn is active", () => {
    for (const elapsedDrainMs of [0, 1000, 299_999, 300_000, 900_000]) {
      const verdict = evaluateUpgradeGate(gate({ drain: { activeTurnCount: 1 }, elapsedDrainMs }));
      expect(verdict.decision).not.toBe("swap");
    }
  });

  it("swaps a first-ever install where nothing is currently active", () => {
    expect(evaluateUpgradeGate(gate({ currentReleaseId: null }))).toEqual({ decision: "swap" });
  });
});
