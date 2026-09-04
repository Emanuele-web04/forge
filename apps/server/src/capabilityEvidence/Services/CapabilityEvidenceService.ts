import type {
  CapabilityEvidenceBadge,
  CapabilityEvidenceBadgeResult,
  CapabilityEvidenceDemoteInput,
  CapabilityEvidenceDemoteResult,
  CapabilityAdvertisement,
  CapabilityEvidenceInvalidateInput,
  CapabilityEvidenceInvalidateResult,
  CapabilityEvidenceQuery,
  CapabilityEvidenceQueryResult,
  CapabilityEvidenceRecordInput,
  CapabilityEvidenceRecordResult,
  CapabilityObservation,
  RuntimeTurnFeedbackInput,
  RuntimeTurnFeedbackResult,
} from "@synara/contracts";
import { Data, Effect, Random, ServiceMap } from "effect";

import { CapabilityEvidenceRepository } from "./CapabilityEvidenceRepository.ts";
import {
  CAPABILITY_EVIDENCE_POLICY_VERSION,
  CapabilityPolicyEngine,
} from "./CapabilityPolicyEngine.ts";
import { RuntimeTurnFeedbackService } from "./RuntimeTurnFeedbackService.ts";

export class CapabilityEvidenceError extends Data.TaggedError("CapabilityEvidenceError")<{
  readonly code: "invalid_input" | "repository_error" | "not_found";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface CapabilityEvidenceServiceShape {
  readonly record: (
    input: CapabilityEvidenceRecordInput,
  ) => Effect.Effect<CapabilityEvidenceRecordResult, CapabilityEvidenceError>;
  readonly query: (
    input: CapabilityEvidenceQuery,
  ) => Effect.Effect<CapabilityEvidenceQueryResult, CapabilityEvidenceError>;
  readonly invalidate: (
    input: CapabilityEvidenceInvalidateInput,
  ) => Effect.Effect<CapabilityEvidenceInvalidateResult, CapabilityEvidenceError>;
  /**
   * Demote or purge capability observations for a profile (and optionally a
   * single capability). `purge` hard-deletes dishonest evidence (honeypot
   * verdicts); `demote` withdraws remaining evidence from verdicts while
   * preserving the raw history (KAR-530).
   */
  readonly demote: (
    input: CapabilityEvidenceDemoteInput,
  ) => Effect.Effect<CapabilityEvidenceDemoteResult, CapabilityEvidenceError>;
  /**
   * Records a terminal live-session turn as capability evidence for the
   * running external agent profile. The observation is attributed to the
   * profile namespace and source `runtime`, so the badge and conformance
   * history converge per profile (KAR-530).
   */
  readonly recordRuntimeTurnFeedback: (
    input: RuntimeTurnFeedbackInput,
  ) => Effect.Effect<RuntimeTurnFeedbackResult, CapabilityEvidenceError>;
  /**
   * Badge lookup for a profile: the effective capability state for every
   * capability the evidence store knows about, derived under the current
   * policy version (KAR-530 AC #2). The badge is evidence-driven, never a
   * mutable compatibility flag.
   */
  readonly queryBadge: (
    input: CapabilityEvidenceBadge,
  ) => Effect.Effect<CapabilityEvidenceBadgeResult, CapabilityEvidenceError>;
}

export class CapabilityEvidenceService extends ServiceMap.Service<
  CapabilityEvidenceService,
  CapabilityEvidenceServiceShape
>()("synara/capabilityEvidence/Services/CapabilityEvidenceService") {}

const toRepositoryError = (operation: string) => (cause: unknown) =>
  new CapabilityEvidenceError({
    code: "repository_error",
    message: `Capability evidence ${operation} failed.`,
    ...(cause instanceof Error ? { cause } : {}),
  });

const randomObservationId = (namespace: string, capabilityId: string, now: string) =>
  Effect.gen(function* () {
    const suffix = yield* Random.nextIntBetween(1_000_000, 9_999_999);
    return `${namespace}:${capabilityId}:${now}:${suffix}`;
  });

export const CAPABILITY_EVIDENCE_VERIFIER_ID = "synara-capability-evidence";
export const RUNTIME_FEEDBACK_VERIFIER_ID = "runtime-turn-feedback";

export const makeCapabilityEvidenceService = Effect.gen(function* () {
  const repository = yield* CapabilityEvidenceRepository;
  const policyEngine = yield* CapabilityPolicyEngine;
  const runtimeTurnFeedback = yield* RuntimeTurnFeedbackService;

  const record: CapabilityEvidenceServiceShape["record"] = (input) =>
    Effect.gen(function* () {
      const observationId = yield* randomObservationId(
        input.namespace,
        input.capabilityId,
        input.observedAt,
      );
      const observation: CapabilityObservation = {
        observationId,
        namespace: input.namespace,
        capabilityId: input.capabilityId,
        source: input.source,
        outcome: input.outcome,
        attribution: input.attribution,
        runtime: input.runtime,
        verifier: input.verifier,
        policy: input.policy,
        observedAt: input.observedAt,
        run: input.run,
      };
      yield* repository
        .appendObservation({ observation })
        .pipe(Effect.mapError(toRepositoryError("record")));
      return { observation } satisfies CapabilityEvidenceRecordResult;
    });

  const query: CapabilityEvidenceServiceShape["query"] = (input) =>
    Effect.gen(function* () {
      const observations = yield* repository
        .listObservations(
          input.capabilityId === undefined
            ? { namespace: input.namespace }
            : { namespace: input.namespace, capabilityId: input.capabilityId },
        )
        .pipe(Effect.mapError(toRepositoryError("query")));

      // Separate the advertisement (protocol claims) from verification evidence.
      // `advertised` is true when the agent's latest claim asserts the capability;
      // the verdict derives only from non-claim observations (see the policy
      // engine), so `advertised: true` + `state: "broken"` is representable.
      const latestClaim = [...observations]
        .filter((observation) => observation.source === "protocol-claim")
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .at(-1);
      const advertisement: CapabilityAdvertisement | undefined =
        latestClaim === undefined
          ? undefined
          : {
              capabilityId: latestClaim.capabilityId,
              advertised: latestClaim.outcome === "pass",
              advertisedAt: latestClaim.observedAt,
            };

      // A single derived view only makes sense when the observation set belongs
      // to one capability (either explicitly queried or naturally singular).
      const capabilityIds = new Set(observations.map((observation) => observation.capabilityId));
      const state =
        input.capabilityId !== undefined || capabilityIds.size === 1
          ? policyEngine.deriveEffectiveStateView({
              namespace: input.namespace,
              observations,
              policy: { version: CAPABILITY_EVIDENCE_POLICY_VERSION, params: {} },
              advertisement,
              derivedAt: new Date().toISOString(),
            })
          : undefined;
      return { observations, state } satisfies CapabilityEvidenceQueryResult;
    });

  const invalidate: CapabilityEvidenceServiceShape["invalidate"] = (input) =>
    Effect.gen(function* () {
      yield* repository
        .clearEffectiveStates(input)
        .pipe(Effect.mapError(toRepositoryError("invalidate")));
      return { invalidated: 1 } satisfies CapabilityEvidenceInvalidateResult;
    });

  const demote: CapabilityEvidenceServiceShape["demote"] = (input) =>
    Effect.gen(function* () {
      const result = yield* repository
        .demoteObservations({
          namespace: input.namespace,
          ...(input.capabilityId ? { capabilityId: input.capabilityId } : {}),
          decision: input.decision,
          ...(input.observedAt ? { withdrawnAt: input.observedAt } : {}),
        })
        .pipe(Effect.mapError(toRepositoryError("demote")));
      return result satisfies CapabilityEvidenceDemoteResult;
    });

  const recordRuntimeTurnFeedback: CapabilityEvidenceServiceShape["recordRuntimeTurnFeedback"] = (
    input,
  ) => runtimeTurnFeedback.recordTurnFeedback(input);

  const queryBadge: CapabilityEvidenceServiceShape["queryBadge"] = (input) =>
    Effect.gen(function* () {
      const observations = yield* repository
        .listObservations({ namespace: input.namespace })
        .pipe(Effect.mapError(toRepositoryError("queryBadge")));

      const byCapability = new Map<
        CapabilityObservation["capabilityId"],
        CapabilityObservation[]
      >();
      for (const observation of observations) {
        const existing = byCapability.get(observation.capabilityId);
        if (existing) existing.push(observation);
        else byCapability.set(observation.capabilityId, [observation]);
      }

      const derivedAt = new Date().toISOString();
      const states: Array<CapabilityEvidenceBadgeResult["states"][number]> = [];

      for (const [capabilityId, capabilityObservations] of byCapability) {
        const latestClaim = [...capabilityObservations]
          .filter((observation) => observation.source === "protocol-claim")
          .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
          .at(-1);
        const advertisement: CapabilityAdvertisement | undefined =
          latestClaim === undefined
            ? undefined
            : {
                capabilityId: latestClaim.capabilityId,
                advertised: latestClaim.outcome === "pass",
                advertisedAt: latestClaim.observedAt,
              };
        const state = policyEngine.deriveEffectiveStateView({
          namespace: input.namespace,
          observations: capabilityObservations,
          policy: { version: CAPABILITY_EVIDENCE_POLICY_VERSION, params: {} },
          advertisement,
          derivedAt,
        });
        states.push({
          ...state,
          capabilityId,
        });
      }

      return { states, derivedAt } satisfies CapabilityEvidenceBadgeResult;
    });

  return {
    record,
    query,
    invalidate,
    demote,
    recordRuntimeTurnFeedback,
    queryBadge,
  } satisfies CapabilityEvidenceServiceShape;
});
