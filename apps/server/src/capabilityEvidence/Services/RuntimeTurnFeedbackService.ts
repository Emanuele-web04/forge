// FILE: RuntimeTurnFeedbackService.ts
// Purpose: Maps terminal provider-runtime turn events on external-agent threads
// into immutable capability observations (KAR-530). This is the single source
// of truth for how live-session feedback mutates the capability evidence store:
//
// - `attest` appends the observation unchanged (a pass strengthens evidence).
// - `observe` appends it unchanged (inconclusive readings never promote or
//   demote; they are inert).
// - `withdraw` marks the profile's existing evidence withdrawn (unsafe outcome
//   handled honestly: the raw history is preserved for audit but excluded from
//   verdicts) and appends a hardening observation.
// - `abuse` hard-purges the profile's prior evidence (deliberate misbehavior,
//   e.g. a honeypot verdict, must not survive) and appends a hardening
//   observation.
//
// The disposition is decided by the caller (the ingestion hook or an RPC
// caller) via RuntimeTurnFeedbackInput; the classifier in
// `RuntimeTurnFeedbackClassifier.ts` supplies the honest default projection.
// Layer: Server capability-evidence feedback
// Exports: RuntimeTurnFeedbackService, makeRuntimeTurnFeedbackService
// Depends on: CapabilityEvidenceRepository (append + purge/demote)

import { Effect, ServiceMap } from "effect";
import { externalAgentEvidenceNamespace } from "@synara/shared/capabilityEvidence";

import type { CapabilityObservation, RuntimeTurnFeedbackResult } from "@synara/contracts";

import { CapabilityEvidenceRepository } from "./CapabilityEvidenceRepository.ts";
import { CapabilityEvidenceError } from "./CapabilityEvidenceService.ts";
import { RUNTIME_FEEDBACK_VERIFIER_ID } from "./RuntimeTurnFeedbackClassifier.ts";
import { CAPABILITY_EVIDENCE_POLICY_VERSION, makePolicySpec } from "./CapabilityPolicyEngine.ts";

const feedbackError = (operation: string) => (cause: unknown) =>
  new CapabilityEvidenceError({
    code: "repository_error",
    message: `Runtime turn feedback ${operation} failed.`,
    ...(cause instanceof Error ? { cause } : {}),
  });

/**
 * Deterministic observation id derived from the turn itself, so replayed or
 * re-journaled turn events are idempotent (the repository INSERT becomes a
 * no-op instead of duplicating evidence, KAR-530 "no flooding"). The turn id
 * is a stable fingerprint of the terminal event; when missing we fall back to
 * a random suffix (an unidentified turn is never attributed twice).
 */
const observationId = (input: {
  readonly namespace: string;
  readonly capabilityId: string;
  readonly threadId: string;
  readonly turnId?: string;
  readonly now: string;
}): string =>
  input.turnId
    ? `${input.namespace}:${input.capabilityId}:${input.threadId}:${input.turnId}`
    : `${input.namespace}:${input.capabilityId}:${input.threadId}:${input.now}:${randomSuffix()}`;

let randomSuffixCounter = 0;
const randomSuffix = () =>
  `${Date.now().toString(36)}-${(randomSuffixCounter++ % 1_000_000).toString(36)}`;

export interface RuntimeTurnFeedbackServiceShape {
  /**
   * Records one terminal turn as capability evidence for the running external
   * agent profile/revision.
   *
   * - `attest` appends the observation unchanged (a pass strengthens evidence).
   * - `observe` appends it unchanged (inconclusive readings never promote or
   *   demote; they are inert).
   * - `withdraw` marks the profile's existing evidence withdrawn (the raw
   *   history is preserved for audit but excluded from verdicts) and appends a
   *   hardening observation.
   * - `abuse` hard-purges the profile's prior evidence (deliberate
   *   misbehavior must not survive) and appends a hardening observation.
   */
  readonly recordTurnFeedback: (
    input: import("@synara/contracts").RuntimeTurnFeedbackInput,
  ) => Effect.Effect<RuntimeTurnFeedbackResult, CapabilityEvidenceError>;
}

export class RuntimeTurnFeedbackService extends ServiceMap.Service<
  RuntimeTurnFeedbackService,
  RuntimeTurnFeedbackServiceShape
>()("synara/capabilityEvidence/Services/RuntimeTurnFeedbackService") {}

export const makeRuntimeTurnFeedbackService = Effect.gen(function* () {
  const repository = yield* CapabilityEvidenceRepository;

  const recordTurnFeedback: RuntimeTurnFeedbackServiceShape["recordTurnFeedback"] = (input) =>
    Effect.gen(function* () {
      const namespace = externalAgentEvidenceNamespace(input.profileId);
      const now = input.completedAt ?? new Date().toISOString();
      const policy = makePolicySpec(input.policyVersion ?? CAPABILITY_EVIDENCE_POLICY_VERSION);

      const buildObservation = (
        outcome: CapabilityObservation["outcome"],
      ): CapabilityObservation => ({
        observationId: observationId({
          namespace,
          capabilityId: input.capabilityId,
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          now,
        }),
        namespace,
        capabilityId: input.capabilityId,
        source: "runtime",
        outcome,
        attribution: input.attribution,
        runtime: {},
        verifier: { verifierId: RUNTIME_FEEDBACK_VERIFIER_ID },
        policy,
        observedAt: now,
        run: {
          threadId: input.threadId,
          ...(input.turnId !== undefined ? { turnId: input.turnId } : {}),
          ...(input.runtimeSessionId !== undefined
            ? { runtimeSessionId: input.runtimeSessionId }
            : {}),
          ...(input.revisionId !== undefined ? { revisionId: input.revisionId } : {}),
          ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
          ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
          ...(input.detail !== undefined ? { detail: input.detail } : {}),
        },
      });

      const disposition = input.disposition;

      if (disposition === "abuse") {
        // Honeypot caught deliberate misbehavior: the profile's prior evidence
        // is dishonest and must not survive. Purge it, then record what
        // happened as a hard agent failure.
        const purge = yield* repository
          .demoteObservations({
            namespace,
            ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
            decision: "purge",
          })
          .pipe(Effect.mapError(feedbackError("purge")));
        const observation = buildObservation("fail");
        yield* repository
          .appendObservation({ observation })
          .pipe(Effect.mapError(feedbackError("append")));
        return {
          observation,
          disposition,
          ...(purge.purged > 0 ? { purged: purge.purged } : {}),
        } satisfies RuntimeTurnFeedbackResult;
      }

      if (disposition === "withdraw") {
        // A real session contradicted prior assertion. Withdraw (mark) the
        // profile's existing rows so the badge no longer claims the capability,
        // without fabricating an agent failure and without corrupting the raw
        // evidence history (KAR-530 AC #4/#5). The hardening observation is
        // *inconclusive*: an agent-attributable live failure withdraws prior
        // claims but is never a hard `fail` the policy would read as `broken`
        // — the documented withdraw semantics are `unknown`/`provisional`.
        const demoteResult = yield* repository
          .demoteObservations({
            namespace,
            ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
            decision: "demote",
            withdrawnAt: now,
          })
          .pipe(Effect.mapError(feedbackError("demote")));
        const observation = buildObservation("inconclusive");
        yield* repository
          .appendObservation({ observation })
          .pipe(Effect.mapError(feedbackError("append")));
        return {
          observation,
          disposition,
          ...(demoteResult.demoted > 0 ? { demoted: demoteResult.demoted } : {}),
        } satisfies RuntimeTurnFeedbackResult;
      }

      const observation = buildObservation(input.outcome);
      yield* repository
        .appendObservation({ observation })
        .pipe(Effect.mapError(feedbackError("append")));
      return { observation, disposition } satisfies RuntimeTurnFeedbackResult;
    });

  return { recordTurnFeedback } satisfies RuntimeTurnFeedbackServiceShape;
});
