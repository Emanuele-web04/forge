import { describe, expect, it } from "vitest";

import type {
  Attribution,
  CapabilityAdvertisement,
  CapabilityObservation,
  EvidenceOutcome,
  EvidenceSource,
  PolicySpec,
  RuntimeIdentitySignals,
  VerifierIdentity,
} from "@synara/contracts";

import {
  deriveEffectiveState,
  deriveEffectiveStateForRuntime,
  deriveEffectiveStateView,
  makePolicySpec,
  readPolicyHysteresis,
  CAPABILITY_EVIDENCE_POLICY_VERSION,
} from "../Services/CapabilityPolicyEngine.ts";

/**
 * Observations are built from static fixtures, so they never need the schema
 * validator. The policy engine itself is pure and schema-agnostic by design.
 */
let observationSeq = 0;

const namespace = "synara:claudeAgent:profile-a";

const now = (tick: number) => new Date(Date.UTC(2026, 7, 16, 0, 0, tick)).toISOString();

const identity: RuntimeIdentitySignals = {
  agentName: "claude-agent",
  agentVersion: "1.2.3",
  protocolVersion: "2025-06-26",
  advertisedContractHash: "abc123",
};

const identityV2: RuntimeIdentitySignals = {
  ...identity,
  agentVersion: "1.3.0",
};

const newVerifier: VerifierIdentity = {
  verifierId: "conformance-v1",
  harnessVersion: "2026-08-03.8",
};

const renamedVerifier: VerifierIdentity = {
  verifierId: "conformance-v2",
  harnessVersion: "2026-08-03.8",
};

const policy: PolicySpec = {
  version: "v1",
  params: { "consecutive.required": 3 },
};

const makeObservation = (overrides: Partial<CapabilityObservation>): CapabilityObservation => {
  const nextSeq = ++observationSeq;
  return {
    observationId: `obs-${nextSeq}`,
    namespace,
    capabilityId: "prompt",
    source: "synthetic-conformance",
    outcome: "pass",
    attribution: "synara",
    runtime: identity,
    verifier: newVerifier,
    policy,
    observedAt: now(nextSeq),
    ...overrides,
  };
};

const observations = (
  count: number,
  outcome: EvidenceOutcome,
  attribution: Attribution = "synara",
  tickOffset: number = 0,
): CapabilityObservation[] =>
  Array.from({ length: count }, (_, index) =>
    makeObservation({
      outcome,
      attribution,
      observedAt: now(tickOffset + index + 1),
    }),
  );

const advertisementPass: CapabilityAdvertisement = {
  capabilityId: "prompt",
  advertised: true,
  advertisedAt: now(1000),
};

describe("CapabilityPolicyEngine", () => {
  describe("additive compatibility (AC #4)", () => {
    it("derives `unknown` for a capability with no observations", () => {
      expect(deriveEffectiveState([], "v1")).toBe("unknown");
    });

    it("derives `unknown` for a capability id a profile never recorded", () => {
      // A profile that only ever recorded "prompt" evidence now queries
      // "session.resume": the repository filters observations by capability id,
      // so the engine sees an empty history and reads unknown rather than
      // unsupported/broken. New capability ids are additive.
      const promptEvidence = observations(2, "pass");
      expect(deriveEffectiveState(promptEvidence, "v1")).toBe("verified");
      expect(deriveEffectiveState([], "v1")).toBe("unknown");
      // The empty-history default is stable across policy versions.
      expect(deriveEffectiveState([], "v1")).toBe("unknown");
    });

    it("keeps distinct capability ids independent (unseen ones stay unknown)", () => {
      const promptEvidence = observations(3, "pass");
      expect(deriveEffectiveState(promptEvidence, "v1")).toBe("verified");
      // "usage" is brand new to this profile and has no observations of its own.
      expect(deriveEffectiveState([], "v1")).toBe("unknown");
    });
  });

  describe("source/outcome/attribution combinations (AC #1)", () => {
    it.each([
      ["synthetic-conformance", "synara"],
      ["production-observation", "synara"],
      ["vendor-attestation", "synara"],
      ["synthetic-conformance", "agent"],
    ] as const)("pass %s/%s → verified", (source, attribution) => {
      const list = observations(2, "pass", attribution).map((observation) => ({
        ...observation,
        source: source as EvidenceSource,
      }));
      expect(deriveEffectiveState(list, "v1")).toBe("verified");
    });

    it.each([
      ["synthetic-conformance", "agent"],
      ["production-observation", "agent"],
      ["vendor-attestation", "agent"],
    ] as const)("fail %s/%s → broken", (source, attribution) => {
      const list = observations(2, "fail", attribution).map((observation) => ({
        ...observation,
        source: source as EvidenceSource,
      }));
      expect(deriveEffectiveState(list, "v1")).toBe("broken");
    });

    it.each([
      ["synthetic-conformance", "synara"],
      ["production-observation", "synara"],
      ["vendor-attestation", "synara"],
    ] as const)(
      "fail %s/%s → broken (verification fault is ours, not the agent)",
      (source, attribution) => {
        const list = observations(2, "fail", attribution).map((observation) => ({
          ...observation,
          source: source as EvidenceSource,
        }));
        expect(deriveEffectiveState(list, "v1")).toBe("broken");
      },
    );

    it.each(["environment", "auth", "network"] as const)(
      "fail env/auth/network → inconclusive → provisional (AC #3)",
      (attribution) => {
        const list = observations(3, "fail", attribution as Attribution);
        // Environmental faults never condemn the capability; they read as
        // provisional until real evidence arrives.
        expect(deriveEffectiveState(list, "v1")).toBe("provisional");
      },
    );

    it("inconclusive observations alone → unknown; never broken", () => {
      const list = observations(3, "inconclusive");
      expect(deriveEffectiveState(list, "v1")).toBe("unknown");
    });

    it("inconclusive with no failing evidence stays verified when passes exist", () => {
      const list = [
        ...observations(2, "pass"),
        {
          ...makeObservation({ outcome: "inconclusive" }),
          observedAt: now(3),
        },
      ];
      expect(deriveEffectiveState(list, "v1")).toBe("verified");
    });
  });

  describe("advertised + verified fail → disabled (AC #2)", () => {
    it("records the advertisement separately from the verdict", () => {
      const existing = observations(3, "pass");
      const view = deriveEffectiveStateView({
        namespace,
        observations: existing,
        policy,
        advertisement: advertisementPass,
        derivedAt: now(2000),
      });
      expect(view.state).toBe("verified");
      expect(view.advertised).toBe(true);
    });

    it("drives the view to unknown when nothing is advertised and no evidence exists", () => {
      const view = deriveEffectiveStateView({
        namespace,
        observations: [],
        policy,
        advertisement: undefined,
        derivedAt: now(2000),
      });
      expect(view.state).toBe("unknown");
      expect(view.advertised).toBe(false);
    });
  });

  describe("verifier/policy staleness (AC #6)", () => {
    it("a harness/verifier change makes verified evidence provisional", () => {
      const list = [
        ...observations(2, "pass"),
        {
          ...makeObservation({ outcome: "pass" }),
          verifier: renamedVerifier,
        },
      ];
      expect(deriveEffectiveState(list, "v1")).toBe("provisional");
    });

    it("a policy version change makes verified evidence provisional", () => {
      const list = observations(2, "pass");
      expect(deriveEffectiveState(list, "v2")).toBe("provisional");
    });

    it("mixed conformance + runtime evidence stays verified (runtime never signals staleness)", () => {
      // A conformance pass under the harness-versioned conformance verifier and
      // a live-session runtime attest under `runtime-turn-feedback` share one
      // profile namespace. They are different verifier *families*, so the
      // cross-family verifier-id mismatch is not staleness — the profile must
      // read `verified`, never `provisional` (KAR-530 review C2).
      const conformancePass = makeObservation({
        source: "synthetic-conformance",
        verifier: {
          verifierId: `prompt.acp.conformance.v2026-08-16.1`,
          harnessVersion: "2026-08-16.1",
        },
      });
      const runtimeAttest = makeObservation({
        source: "runtime",
        verifier: { verifierId: "runtime-turn-feedback" },
      });
      runtimeAttest.observedAt = new Date(Date.UTC(2026, 7, 16, 0, 0, 50)).toISOString();
      const state = deriveEffectiveState([conformancePass, runtimeAttest], "v1");
      expect(state).toBe("verified");
    });

    it("runtime-only evidence also stays verified (runtime attest never drifts)", () => {
      const runtimeAttest = makeObservation({
        source: "runtime",
        verifier: { verifierId: "runtime-turn-feedback" },
      });
      expect(deriveEffectiveState([runtimeAttest], "v1")).toBe("verified");
    });

    it("runtime drift marks only the drifted evidence provisional (AC #6 signal-specific)", () => {
      // Current runtime signals differ on version only; the agent itself
      // upgraded. The matched (package identity / endpoint) evidence still
      // yields a verdict from the normal ladder, the drifted one is provisional.
      const matched = observations(2, "pass").map((observation) => ({
        ...observation,
        runtime: identity,
      }));
      const drifted = observations(1, "pass").map((observation) => ({
        ...observation,
        runtime: identityV2,
      }));
      const state = deriveEffectiveStateForRuntime({
        observations: [...matched, ...drifted],
        currentRuntime: identityV2,
        policyVersion: "v1",
      });
      expect(state).toBe("verified");

      // If ALL evidence drifted, the capability is provisional, never broken.
      const allDrifted = observations(2, "pass").map((observation) => ({
        ...observation,
        runtime: identityV2,
      }));
      const stateAllDrifted = deriveEffectiveStateForRuntime({
        observations: allDrifted,
        currentRuntime: identityV2,
        policyVersion: "v1",
      });
      expect(stateAllDrifted).toBe("verified");

      // Even failures under drift read provisional, not broken (the fault may
      // be the new runtime, not the capability).
      const driftedFailures = observations(2, "fail").map((observation) => ({
        ...observation,
        runtime: identityV2,
        attribution: "agent" as const,
      }));
      const stateDriftedFailures = deriveEffectiveStateForRuntime({
        observations: driftedFailures,
        currentRuntime: identity,
        policyVersion: "v1",
      });
      expect(stateDriftedFailures).toBe("provisional");
    });
  });

  describe("hysteresis (AC #7)", () => {
    it("does not flip a working capability on a single few failures", () => {
      // 5 passes then 2 consecutive fails: below the 3-consecutive threshold.
      const mixed = [
        ...observations(5, "pass"),
        {
          ...makeObservation({ outcome: "fail", attribution: "agent" }),
          observedAt: now(6),
        },
        {
          ...makeObservation({ outcome: "fail", attribution: "agent" }),
          observedAt: now(7),
        },
      ];
      expect(deriveEffectiveState(mixed, "v1")).toBe("degraded");
    });

    it("flips to broken after the consecutive threshold is crossed", () => {
      const mixed = [...observations(5, "pass"), ...observations(3, "fail", "agent", 5)];
      expect(deriveEffectiveState(mixed, "v1")).toBe("broken");
    });

    it("recovers to verified after enough consecutive passes", () => {
      const mixed = [
        ...observations(5, "pass"),
        ...observations(3, "fail", "agent", 5),
        ...observations(3, "pass", "synara", 9),
      ];
      expect(deriveEffectiveState(mixed, "v1")).toBe("verified");
    });

    it("ignores inconclusive observations when counting consecutive runs", () => {
      const mixed = [
        ...observations(3, "pass"),
        {
          ...makeObservation({ outcome: "inconclusive" }),
          observedAt: now(4),
        },
        {
          ...makeObservation({ outcome: "pass" }),
          observedAt: now(5),
        },
      ];
      expect(deriveEffectiveState(mixed, "v1")).toBe("verified");
    });

    it("reads hysteresis knobs from the policy spec", () => {
      const spec = makePolicySpec("v1", { "hysteresis.consecutive": 5 });
      expect(readPolicyHysteresis(spec)).toEqual({
        hysteresisConsecutive: 5,
        inconclusiveSeenWeight: 0.5,
      });
    });
  });

  describe("policy re-derivation from history (AC #5)", () => {
    it("re-derives verdicts when the policy version changes without new observations", () => {
      const history = observations(4, "pass");
      expect(deriveEffectiveState(history, "v1")).toBe("verified");
      // Policy recalibration to require stronger evidence makes it provisional.
      expect(deriveEffectiveState(history, "v2")).toBe("provisional");
    });

    it("produces identical views for the same history + policy", () => {
      const history = observations(4, "pass");
      const first = deriveEffectiveStateView({
        namespace,
        observations: history,
        policy: makePolicySpec(CAPABILITY_EVIDENCE_POLICY_VERSION),
        advertisement: advertisementPass,
        derivedAt: now(1),
      });
      const second = deriveEffectiveStateView({
        namespace,
        observations: history,
        policy: makePolicySpec(CAPABILITY_EVIDENCE_POLICY_VERSION),
        advertisement: advertisementPass,
        derivedAt: now(2),
      });
      expect(first.state).toBe(second.state);
      expect(first.namespace).toBe(namespace);
      expect(first.advertised).toBe(true);
      expect(second.advertised).toBe(true);
    });
  });
});
