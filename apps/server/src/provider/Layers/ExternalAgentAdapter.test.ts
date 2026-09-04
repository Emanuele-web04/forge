// FILE: ExternalAgentAdapter.test.ts
// Purpose: Characterize the external agent adapter's harness policy delivery
// and launch-spec resolution — the two behaviors unique to profile-driven
// external agents vs. built-in ACP providers.
// Layer: Provider adapter tests

import { SYNARA_HARNESS_POLICY_MARKER } from "../../agentGateway/harnessPolicy.ts";
import { describe, expect, it } from "vitest";

import { takeExternalSynaraHarnessPolicyTextPart } from "./ExternalAgentAdapter.ts";

describe("External agent Synara harness policy", () => {
  it("delivers scoped MCP host context exactly once per fresh/load/fork session", () => {
    for (const lifecycle of ["fresh", "load", "fork"] as const) {
      const state: { harnessPolicyDelivered?: boolean } = {};
      const first = takeExternalSynaraHarnessPolicyTextPart(state, true);
      expect(first?.text, lifecycle).toContain(SYNARA_HARNESS_POLICY_MARKER);
      expect(first?.text, lifecycle).toContain("Use the synara_* tools");
      // Second call returns null: the policy is delivered exactly once.
      expect(takeExternalSynaraHarnessPolicyTextPart(state, true), lifecycle).toBeNull();
    }
  });

  it("stays truthful without a scoped gateway connection", () => {
    expect(takeExternalSynaraHarnessPolicyTextPart({}, false)?.text).toContain(
      "Synara MCP control is unavailable",
    );
  });

  it("marks delivery state so subsequent calls are no-ops", () => {
    const state: { harnessPolicyDelivered?: boolean } = {};
    takeExternalSynaraHarnessPolicyTextPart(state, true);
    expect(state.harnessPolicyDelivered).toBe(true);
  });
});
