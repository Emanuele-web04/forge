import { describe, expect, it } from "vitest";

import { buildConnectionPlan, ConnectionPlanPolicyViolation } from "./ConnectionPlanPolicy.ts";
import type { ConnectionCandidate } from "@synara/contracts";

function baseCandidate(overrides: Partial<ConnectionCandidate> = {}): ConnectionCandidate {
  return {
    candidateId: "recipe:test-agent:/usr/local/bin/agent",
    agentId: "test-agent",
    displayName: "Test Agent",
    source: "recipe",
    resolvedPath: "/usr/local/bin/agent",
    provenance: { source: "recipe", version: "1.2.3" },
    order: 0,
    ...overrides,
  } as ConnectionCandidate;
}

describe("ConnectionPlanPolicy — safe plan gate (AC #6)", () => {
  it("accepts a candidate with a resolved absolute binary path", () => {
    const plan = buildConnectionPlan({
      candidate: baseCandidate(),
      planId: "plan:test",
      resolvedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(plan.launch.kind).toBe("command");
    if (plan.launch.kind === "command") {
      expect(plan.launch.command).toBe("/usr/local/bin/agent");
    }
    expect(plan.provenance.source).toBe("recipe");
  });

  it("rejects a launch command that is not an absolute path", () => {
    expect(() =>
      buildConnectionPlan({
        candidate: baseCandidate({ resolvedPath: "agent" }),
        planId: "plan:test",
        resolvedAt: "2026-08-16T00:00:00.000Z",
      }),
    ).toThrow(ConnectionPlanPolicyViolation);
  });

  it("rejects a launch command that looks like a shell string (spaces/operators)", () => {
    for (const bad of [
      "/bin/sh -c 'evil'",
      "/usr/bin/curl http://example.com | sh",
      "npm install -g agent && agent",
    ]) {
      expect(() =>
        buildConnectionPlan({
          candidate: baseCandidate({ resolvedPath: bad }),
          planId: "plan:test",
          resolvedAt: "2026-08-16T00:00:00.000Z",
        }),
      ).toThrow(ConnectionPlanPolicyViolation);
    }
  });

  it("rejects a candidate with no local binary and no endpoint (registry-only)", () => {
    let thrown: unknown;
    try {
      buildConnectionPlan({
        candidate: baseCandidate({
          resolvedPath: undefined,
          resolvedEndpoint: undefined,
          install: { kind: "npx", package: "test-agent" },
        }),
        planId: "plan:test",
        resolvedAt: "2026-08-16T00:00:00.000Z",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectionPlanPolicyViolation);
    expect((thrown as ConnectionPlanPolicyViolation).code).toBe("catalogOnly");
  });

  it("refuses a configured-but-missing binary with code missingBinary", () => {
    let thrown: unknown;
    try {
      buildConnectionPlan({
        candidate: baseCandidate({
          resolvedPath: undefined,
          resolvedEndpoint: undefined,
          versionProbe: {
            state: "missing",
            detail: "No executable `ghost-agent` found on PATH.",
            probedAt: "2026-08-16T00:00:00.000Z",
          },
        }),
        planId: "plan:test",
        resolvedAt: "2026-08-16T00:00:00.000Z",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConnectionPlanPolicyViolation);
    expect((thrown as ConnectionPlanPolicyViolation).code).toBe("missingBinary");
  });

  it("accepts an explicit http(s) endpoint candidate", () => {
    const plan = buildConnectionPlan({
      candidate: baseCandidate({
        resolvedPath: undefined,
        resolvedEndpoint: "https://agent.example.com",
      }),
      planId: "plan:test",
      resolvedAt: "2026-08-16T00:00:00.000Z",
    });
    expect(plan.launch.kind).toBe("endpoint");
  });

  it("rejects a candidate with no provenance", () => {
    expect(() =>
      buildConnectionPlan({
        candidate: baseCandidate({
          resolvedPath: "/usr/local/bin/agent",
          provenance: { source: "   " },
        }),
        planId: "plan:test",
        resolvedAt: "2026-08-16T00:00:00.000Z",
      }),
    ).toThrow(ConnectionPlanPolicyViolation);
  });
});
