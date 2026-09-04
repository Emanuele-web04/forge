import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import type { PolicySpec, RuntimeIdentitySignals, VerifierIdentity } from "@synara/contracts";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { capabilityEvidenceLayer } from "../Layers/CapabilityEvidenceService.ts";
import { CAPABILITY_EVIDENCE_POLICY_VERSION } from "./CapabilityPolicyEngine.ts";
import { CapabilityEvidenceService } from "./CapabilityEvidenceService.ts";

const testLayer = capabilityEvidenceLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const layer = it.layer(testLayer);

let profileSeq = 0;
const namespace = () => `synara:claudeAgent:profile-${++profileSeq}`;
const identity: RuntimeIdentitySignals = {
  agentName: "claude-agent",
  agentVersion: "1.2.3",
  protocolVersion: "2025-06-26",
  advertisedContractHash: "abc123",
};
const verifier: VerifierIdentity = {
  verifierId: "conformance-v1",
  harnessVersion: "2026-08-03.8",
};
const policy: PolicySpec = { version: CAPABILITY_EVIDENCE_POLICY_VERSION, params: {} };

let seq = 0;
const observedAt = () => new Date(Date.UTC(2026, 7, 16, 0, 0, ++seq)).toISOString();

describe("CapabilityEvidenceService", () => {
  layer("append-only record + query (AC #1, #2, #5)", (it) => {
    it.effect("records observations and queries them back with a derived state", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();

        const recorded = yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "synthetic-conformance",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        assert.strictEqual(recorded.observation.outcome, "pass");

        const result = yield* service.query({ namespace: ns, capabilityId: "prompt" });
        assert.strictEqual(result.observations.length, 1);
        assert.strictEqual(result.state?.capabilityId, "prompt");
        assert.strictEqual(result.state?.state, "verified");
      }),
    );

    it.effect("advertised + verified fail → disabled (AC #2 persists the combination)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        yield* service.record({
          namespace: ns,
          capabilityId: "session.start",
          source: "protocol-claim",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        yield* service.record({
          namespace: ns,
          capabilityId: "session.start",
          source: "synthetic-conformance",
          outcome: "fail",
          attribution: "agent",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });

        const result = yield* service.query({ namespace: ns, capabilityId: "session.start" });
        const broken = result.observations.find((ob) => ob.capabilityId === "session.start");
        assert.ok(broken);
        assert.strictEqual(broken.outcome, "fail");
        // `advertised: true` (from the protocol claim) + `state: "broken"`
        // (first verification failed) is the canonical disabled combination.
        assert.strictEqual(result.state?.advertised, true);
        assert.strictEqual(result.state?.state, "broken");
      }),
    );

    it.effect("env/auth/network failures read inconclusive (AC #3)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        yield* service.record({
          namespace: ns,
          capabilityId: "stream",
          source: "production-observation",
          outcome: "fail",
          attribution: "network",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        const result = yield* service.query({ namespace: ns, capabilityId: "stream" });
        assert.strictEqual(result.observations[0]?.attribution, "network");
        assert.strictEqual(result.state?.state, "provisional");
      }),
    );

    it.effect("new capability reads unknown for profiles with no history (AC #4)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "production-observation",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        const result = yield* service.query({ namespace: ns, capabilityId: "model.switch" });
        assert.strictEqual(result.observations.length, 0);
        assert.strictEqual(result.state?.state, "unknown");
      }),
    );

    it.effect("never overwrites earlier observations (append-only)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        const first = yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "vendor-attestation",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        const second = yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "synthetic-conformance",
          outcome: "fail",
          attribution: "agent",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        assert.notEqual(first.observation.observationId, second.observation.observationId);

        const result = yield* service.query({ namespace: ns, capabilityId: "prompt" });
        assert.strictEqual(result.observations.length, 2);
      }),
    );

    it.effect("invalidate clears derived state without touching observations (AC #5)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "synthetic-conformance",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        const before = yield* service.query({ namespace: ns, capabilityId: "prompt" });
        assert.strictEqual(before.state?.state, "verified");

        const invalidation = yield* service.invalidate({ namespace: ns });
        assert.strictEqual(invalidation.invalidated, 1);

        const after = yield* service.query({ namespace: ns, capabilityId: "prompt" });
        assert.strictEqual(after.state?.state, "verified"); // re-derived from history
      }),
    );
  });

  layer("badge (AC #2): evidence store drives the badge", (it) => {
    it.effect("collapses all known capabilities into a derived summary", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const ns = namespace();
        // One capability verified, one inconclusive.
        yield* service.record({
          namespace: ns,
          capabilityId: "prompt",
          source: "synthetic-conformance",
          outcome: "pass",
          attribution: "synara",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });
        yield* service.record({
          namespace: ns,
          capabilityId: "stream",
          source: "runtime",
          outcome: "inconclusive",
          attribution: "unknown",
          runtime: identity,
          verifier,
          policy,
          observedAt: observedAt(),
        });

        const badge = yield* service.queryBadge({ namespace: ns });
        const prompt = badge.states.find((state) => state.capabilityId === "prompt");
        const stream = badge.states.find((state) => state.capabilityId === "stream");
        assert.strictEqual(prompt?.state, "verified");
        assert.ok(stream);
        assert.notStrictEqual(stream.state, "verified");
        assert.ok(badge.derivedAt);
      }),
    );

    it.effect("reads unknown for a profile with no evidence (never fabricates)", () =>
      Effect.gen(function* () {
        const service = yield* CapabilityEvidenceService;
        const badge = yield* service.queryBadge({ namespace: namespace() });
        assert.deepStrictEqual(badge.states, []);
      }),
    );
  });
});
