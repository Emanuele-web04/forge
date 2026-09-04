// FILE: RuntimeTurnFeedbackClassifier.test.ts
// Purpose: Unit tests for the pure terminal-turn classifier that maps provider
// runtime turn signals into capability-evidence feedback (KAR-530). The
// honeypot and unsafe-outcome paths must never be able to *promote* evidence:
// every disposition moves toward purge/demote/neutral.
// Layer: Server capability-evidence feedback (pure)

import { describe, expect, it } from "vitest";

import {
  classifyRuntimeTurnAttribution,
  classifyRuntimeTurnDisposition,
  classifyRuntimeTurnFeedbackInput,
  type RuntimeTurnFeedbackTurnSignals,
} from "./RuntimeTurnFeedbackClassifier.ts";

describe("classifyRuntimeTurnAttribution", () => {
  it("reads an empty message as unknown", () => {
    expect(classifyRuntimeTurnAttribution(null)).toBe("unknown");
    expect(classifyRuntimeTurnAttribution(undefined)).toBe("unknown");
    expect(classifyRuntimeTurnAttribution("   ")).toBe("unknown");
  });

  it("reads environmental markers as environment, never agent (AC3/A4 attribution)", () => {
    for (const marker of [
      "Authentication failed: invalid token",
      "credential rejected",
      "network unreachable",
      "request timed out",
      "sandbox disk full",
      "out of memory",
    ]) {
      expect(classifyRuntimeTurnAttribution(marker)).toBe("environment");
    }
  });

  it("reads a non-environmental failure as agent-attributable (AC4 unsafe outcome)", () => {
    expect(classifyRuntimeTurnAttribution("the agent wrote to the wrong branch")).toBe("agent");
    expect(classifyRuntimeTurnAttribution("refused to run the requested change")).toBe("agent");
  });
});

describe("classifyRuntimeTurnDisposition", () => {
  it("completed turns attest (AC1 attestation)", () => {
    expect(
      classifyRuntimeTurnDisposition({
        turnState: "completed",
      } satisfies RuntimeTurnFeedbackTurnSignals),
    ).toBe("attest");
  });

  it("interrupted/cancelled turns observe (inert, never promotable)", () => {
    expect(classifyRuntimeTurnDisposition({ turnState: "interrupted" })).toBe("observe");
    expect(classifyRuntimeTurnDisposition({ turnState: "cancelled" })).toBe("observe");
  });

  it("failed turns with agent attribution withdraw the capability evidence (AC4)", () => {
    expect(
      classifyRuntimeTurnDisposition({
        turnState: "failed",
        errorMessage: "agent produced invalid SQL",
      }),
    ).toBe("withdraw");
  });

  it("failed turns that look environmental or empty observe — never a global withdraw (AC3)", () => {
    expect(
      classifyRuntimeTurnDisposition({
        turnState: "failed",
        errorMessage: "token expired",
      }),
    ).toBe("observe");
    expect(classifyRuntimeTurnDisposition({ turnState: "failed" })).toBe("observe");
  });
});

describe("classifyRuntimeTurnFeedbackInput", () => {
  it("maps a completed turn to a pass/agent/attest shadow (AC1)", () => {
    expect(classifyRuntimeTurnFeedbackInput({ turnState: "completed" })).toEqual({
      outcome: "pass",
      attribution: "agent",
      disposition: "attest",
    });
  });

  it("maps a failed agent-attributable turn to inconclusive/withdraw (AC4)", () => {
    expect(
      classifyRuntimeTurnFeedbackInput({
        turnState: "failed",
        errorMessage: "agent corrupted the repository",
      }),
    ).toEqual({
      outcome: "inconclusive",
      attribution: "agent",
      disposition: "withdraw",
    });
  });

  it("maps a failed environmental turn to inconclusive/observe (AC3)", () => {
    expect(
      classifyRuntimeTurnFeedbackInput({
        turnState: "failed",
        errorMessage: "gateway timeout",
      }),
    ).toEqual({
      outcome: "inconclusive",
      attribution: "environment",
      disposition: "observe",
    });
  });

  it("maps interrupted/cancelled turns to inconclusive/observe (inert)", () => {
    expect(classifyRuntimeTurnFeedbackInput({ turnState: "interrupted" })).toEqual({
      outcome: "inconclusive",
      attribution: "unknown",
      disposition: "observe",
    });
    expect(classifyRuntimeTurnFeedbackInput({ turnState: "cancelled" })).toEqual({
      outcome: "inconclusive",
      attribution: "unknown",
      disposition: "observe",
    });
  });

  it("honors an explicit honeypot verdict as abuse (AC3, prod honeypot)", () => {
    // Even a turn that "succeeded" cannot promote evidence when the caller
    // flags an induced fault as deliberate abuse: it must purge, not attest.
    expect(classifyRuntimeTurnFeedbackInput({ turnState: "completed" }, true)).toEqual({
      outcome: "fail",
      attribution: "agent",
      disposition: "abuse",
    });
    expect(classifyRuntimeTurnFeedbackInput({ turnState: "failed" }, true)).toEqual({
      outcome: "fail",
      attribution: "agent",
      disposition: "abuse",
    });
  });
});
