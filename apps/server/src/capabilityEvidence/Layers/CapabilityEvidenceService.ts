import { Layer } from "effect";

import { CapabilityEvidenceRepositoryLive } from "./CapabilityEvidenceRepository.ts";
import {
  CapabilityEvidenceService,
  makeCapabilityEvidenceService,
} from "../Services/CapabilityEvidenceService.ts";
import {
  CapabilityPolicyEngine,
  makeCapabilityPolicyEngine,
} from "../Services/CapabilityPolicyEngine.ts";
import {
  RuntimeTurnFeedbackService,
  makeRuntimeTurnFeedbackService,
} from "../Services/RuntimeTurnFeedbackService.ts";
import {
  CapabilityVerifierRegistryLive,
  ConformanceRunnerLive,
} from "../../conformance/ConformanceRunner.ts";

export const CapabilityPolicyEngineLive = Layer.effect(
  CapabilityPolicyEngine,
  makeCapabilityPolicyEngine,
);

export const RuntimeTurnFeedbackServiceLive = Layer.effect(
  RuntimeTurnFeedbackService,
  makeRuntimeTurnFeedbackService,
);

export const CapabilityEvidenceServiceLayer = Layer.effect(
  CapabilityEvidenceService,
  makeCapabilityEvidenceService,
);

/**
 * The capability/evidence service graph: repository (append-only persistence),
 * policy engine (pure verdict derivation), the service that glues them, the
 * runtime-turn feedback service (live-session evidence, KAR-530), the ACP
 * verifier registry with its registered bindings, and the conformance runner.
 * The conformance runner and evidence service are composed over their direct
 * dependencies, and each primitive is merged into one layer whose only
 * remaining service requirement is SQLite.
 */
export const capabilityEvidenceLayer = Layer.mergeAll(
  CapabilityEvidenceServiceLayer.pipe(
    Layer.provide(RuntimeTurnFeedbackServiceLive),
    Layer.provide(CapabilityEvidenceRepositoryLive),
    Layer.provide(CapabilityPolicyEngineLive),
  ),
  RuntimeTurnFeedbackServiceLive.pipe(Layer.provide(CapabilityEvidenceRepositoryLive)),
  ConformanceRunnerLive.pipe(
    Layer.provide(CapabilityEvidenceRepositoryLive),
    Layer.provide(CapabilityPolicyEngineLive),
    Layer.provide(CapabilityVerifierRegistryLive),
  ),
  CapabilityEvidenceRepositoryLive,
  CapabilityPolicyEngineLive,
  CapabilityVerifierRegistryLive,
);
