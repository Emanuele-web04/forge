// FILE: RuntimeTurnFeedbackService.test.ts
// Purpose: Service-level assertions that live-session turn feedback mutates the
// capability evidence store the way the ticket demands (KAR-530):
//
// - AC1 attest: a completed turn records a runtime-source observation and the
//   badge derives from it.
// - AC3 abuse (honeypot): an abusive disposition purges the profile's prior
//   evidence — never promotes it.
// - AC4 withdraw (unsafe outcome): a real session contradiction demotes prior
//   evidence (preserving raw history, removing it from verdicts) instead of
//   inflating confidence.
// Layer: Server capability-evidence feedback

import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import type { RuntimeTurnFeedbackInput } from "@synara/contracts";

import { externalAgentEvidenceNamespace } from "@synara/shared/capabilityEvidence";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { capabilityEvidenceLayer } from "../Layers/CapabilityEvidenceService.ts";
import { CapabilityEvidenceRepository } from "./CapabilityEvidenceRepository.ts";
import { CapabilityEvidenceService } from "./CapabilityEvidenceService.ts";
import { RUNTIME_FEEDBACK_VERIFIER_ID } from "./RuntimeTurnFeedbackClassifier.ts";
import { RuntimeTurnFeedbackService } from "./RuntimeTurnFeedbackService.ts";

const testLayer = capabilityEvidenceLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
const layer = it.layer(testLayer);

let profileSeq = 0;

const baseInput = (): RuntimeTurnFeedbackInput => ({
  threadId: `thread-rtf-${++profileSeq}`,
  turnId: "turn-1",
  profileId: `profile-rtf-${profileSeq}`,
  revisionId: "rev-1",
  capabilityId: "prompt",
  outcome: "pass",
  attribution: "agent",
  disposition: "attest",
  completedAt: "2026-08-16T01:02:03.000Z",
});

describe("RuntimeTurnFeedbackService", () => {
  layer("attest (AC1): completed turns stream runtime evidence and drive the badge", (it) => {
    it.effect("records a runtime-source observation that the badge derives from", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const evidence = yield* CapabilityEvidenceService;

        const input = baseInput();
        const result = yield* service.recordTurnFeedback(input);
        assert.strictEqual(result.disposition, "attest");
        assert.strictEqual(result.observation.source, "runtime");
        assert.strictEqual(result.observation.verifier.verifierId, RUNTIME_FEEDBACK_VERIFIER_ID);
        assert.strictEqual(
          result.observation.namespace,
          externalAgentEvidenceNamespace(input.profileId),
        );

        const badge = yield* evidence.queryBadge({
          namespace: externalAgentEvidenceNamespace(input.profileId),
        });
        const promptState = badge.states.find((state) => state.capabilityId === "prompt");
        assert.ok(promptState);
        assert.strictEqual(promptState.state, "verified");
      }),
    );

    it.effect("is idempotent for a replayed turn (does not flood the store)", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const evidence = yield* CapabilityEvidenceService;

        const input = baseInput();
        yield* service.recordTurnFeedback(input);
        yield* service.recordTurnFeedback(input);

        const query = yield* evidence.query({
          namespace: externalAgentEvidenceNamespace(input.profileId),
          capabilityId: "prompt",
        });
        assert.strictEqual(query.observations.length, 1);
      }),
    );
  });

  layer("withdraw (AC4): unsafe outcomes demote evidence, never inflate it", (it) => {
    it.effect("withdraws prior claims and reads the capability as unknown, not broken", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const evidence = yield* CapabilityEvidenceService;

        // First: a passing session claims the capability.
        const input = baseInput();
        yield* service.recordTurnFeedback(input);

        // Then: a real session fails with an agent-attributable unsafe outcome.
        const unsafe = {
          ...input,
          turnId: "turn-2",
          outcome: "inconclusive" as const,
          attribution: "agent" as const,
          disposition: "withdraw" as const,
          detail: "agent produced corrupt output",
          completedAt: "2026-08-16T02:00:00.000Z",
        };
        const result = yield* service.recordTurnFeedback(unsafe);
        assert.strictEqual(result.disposition, "withdraw");
        assert.isAtLeast(result.demoted ?? 0, 1);
        // The hardening observation withdraw leaves behind is inconclusive:
        // the unsafe session withdraws prior claims but never fabricates a
        // hard failure the policy would read as `broken`.
        assert.strictEqual(result.observation.outcome, "inconclusive");

        // The badge no longer derives 'verified' — the unsafe outcome removed
        // the claim rather than stacking on top of it, and reads `unknown`
        // (the documented withdraw semantics), never `broken`.
        const badge = yield* evidence.queryBadge({
          namespace: externalAgentEvidenceNamespace(input.profileId),
        });
        const promptState = badge.states.find((state) => state.capabilityId === "prompt");
        assert.ok(promptState);
        assert.strictEqual(promptState.state, "unknown");
      }),
    );

    it.effect("preserves the raw withdrawn history for audit (includeWithdrawn)", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const repository = yield* CapabilityEvidenceRepository;

        const input = baseInput();
        yield* service.recordTurnFeedback(input);
        yield* service.recordTurnFeedback({
          ...input,
          turnId: "turn-2",
          outcome: "inconclusive" as const,
          attribution: "agent" as const,
          disposition: "withdraw" as const,
          completedAt: "2026-08-16T02:00:00.000Z",
        });

        // Active derivation excludes withdrawn rows…
        const active = yield* repository.listObservations({
          namespace: externalAgentEvidenceNamespace(input.profileId),
          capabilityId: "prompt",
        });
        assert.strictEqual(active.length, 1);
        assert.strictEqual(active[0]!.outcome, "inconclusive");

        // …but the raw history is still fully readable for audit.
        const full = yield* repository.listObservations({
          namespace: externalAgentEvidenceNamespace(input.profileId),
          capabilityId: "prompt",
          includeWithdrawn: true,
        });
        const passRow = full.find((observation) => observation.outcome === "pass");
        assert.ok(passRow, "withdrawn pass observation must survive for audit");
        assert.strictEqual(full.length, 2);
      }),
    );
  });

  layer("abuse (AC3): honeypot verdicts purge evidence, never promote it", (it) => {
    it.effect("purges prior evidence on an abusive disposition", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const evidence = yield* CapabilityEvidenceService;

        const input = baseInput();
        yield* service.recordTurnFeedback(input);

        // Honeypot verdict: deliberate misbehavior discovered via an induced fault.
        const abusive = {
          ...input,
          turnId: "honeypot-turn",
          outcome: "fail" as const,
          attribution: "agent" as const,
          disposition: "abuse" as const,
          completedAt: "2026-08-16T03:00:00.000Z",
        };
        const result = yield* service.recordTurnFeedback(abusive);
        assert.strictEqual(result.disposition, "abuse");
        assert.isAtLeast(result.purged ?? 0, 1);

        // The badge sees no verified state from the purged evidence; the
        // capability is no longer claimed.
        const badge = yield* evidence.queryBadge({
          namespace: externalAgentEvidenceNamespace(input.profileId),
        });
        const promptState = badge.states.find((state) => state.capabilityId === "prompt");
        assert.ok(promptState);
        assert.notStrictEqual(promptState.state, "verified");
      }),
    );
  });

  layer("observe (inert): interrupted/cancelled turns never promote or demote", (it) => {
    it.effect("records an inconclusive observation that leaves the badge neutral", () =>
      Effect.gen(function* () {
        const service = yield* RuntimeTurnFeedbackService;
        const evidence = yield* CapabilityEvidenceService;

        const input = {
          ...baseInput(),
          outcome: "inconclusive" as const,
          attribution: "unknown" as const,
          disposition: "observe" as const,
        };
        const result = yield* service.recordTurnFeedback(input);
        assert.strictEqual(result.disposition, "observe");
        assert.strictEqual(result.observation.outcome, "inconclusive");

        const badge = yield* evidence.queryBadge({
          namespace: externalAgentEvidenceNamespace(input.profileId),
        });
        const promptState = badge.states.find((state) => state.capabilityId === "prompt");
        assert.ok(promptState);
        assert.notStrictEqual(promptState.state, "verified");
      }),
    );
  });
});
