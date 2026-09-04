// FILE: ConformanceRunner.ts
// Purpose: Orchestrates a single external-agent capability conformance run:
// resolves a capable verifier, spawns the agent in a scratch workspace with a
// hard bounded runtime, persists the raw observation append-only, and
// re-derives the effective state cache for the profile.
// Layer: Server capability conformance
// Exports: ConformanceRunnerService, makeConformanceRunner, runConformance,
//          ConformanceRunnerLive

import { Effect, Layer, ServiceMap } from "effect";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CapabilityId,
  CapabilityObservation,
  ExternalAgentNamespace,
  RuntimeIdentitySignals,
} from "@synara/contracts";

import { CapabilityEvidenceRepository } from "../capabilityEvidence/Services/CapabilityEvidenceRepository.ts";
import {
  CapabilityVerifierRegistry,
  makeCapabilityVerifierRegistry,
} from "../capabilityEvidence/Services/CapabilityVerifierRegistry.ts";
import {
  CapabilityPolicyEngine,
  CAPABILITY_EVIDENCE_POLICY_VERSION,
  makePolicySpec,
} from "../capabilityEvidence/Services/CapabilityPolicyEngine.ts";
import { makeAcpVerifierRegistry } from "./AcpConformanceVerifiers.ts";
import { makeCliVerifierRegistry } from "../provider/cli/CliConformanceVerifiers.ts";

export const CONFORMANCE_RUN_COMPLETED_AT_LABEL = "conformance";
export const CONFORMANCE_EVIDENCE_SOURCE = "synthetic-conformance";

/** One run against one capability of one configurable agent fixture. */
export interface ConformanceRunInput {
  readonly namespace: ExternalAgentNamespace;
  readonly capabilityId: CapabilityId;
  readonly runtimeIdentity: RuntimeIdentitySignals;
  /** Agent executable invited into the conformance run (an ACP fixture path). */
  readonly agentCommand: string;
  /**
   * Agent startup environment for the run (e.g. hostile-mode knobs). These are
   * forwarded to the spawned ACP child, not treated as evidence.
   */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /**
   * Whether the capability was advertised (from a session/initialize probe).
   * The runner records an observation regardless; the policy derives the
   * verdict from non-claim verification evidence only (AC #1/#2).
   */
  readonly advertised: boolean;
  readonly policyVersion?: string;
  /** Extra policy params folded into the recorded PolicySpec (e.g. hysteresis). */
  readonly policyParams?: Readonly<Record<string, unknown>>;
}

export interface ConformanceRunResult {
  readonly observation: CapabilityObservation;
  readonly effectiveStateView: {
    readonly capabilityId: CapabilityId;
    readonly state: string;
    readonly advertised: boolean;
  };
}

export interface ConformanceRunnerShape {
  readonly run: (input: ConformanceRunInput) => Effect.Effect<ConformanceRunResult, Error>;
}

export class ConformanceRunner extends ServiceMap.Service<
  ConformanceRunner,
  ConformanceRunnerShape
>()("synara/conformance/ConformanceRunner") {}

export const makeConformanceRunner = Effect.gen(function* () {
  const registry = yield* CapabilityVerifierRegistry;
  const evidence = yield* CapabilityEvidenceRepository;
  const policyEngine = yield* CapabilityPolicyEngine;

  const run: ConformanceRunnerShape["run"] = (input) =>
    Effect.gen(function* () {
      // 1. Resolve a verifier for this profile+capability+runtime. No verifier
      //    means no measurement possible: record nothing (additive contract).
      const verifier = registry.resolve({
        capabilityId: input.capabilityId,
        runtime: input.runtimeIdentity,
      });
      if (verifier === undefined) {
        return yield* Effect.fail(
          new Error(
            `No capability verifier resolved for ${input.capabilityId} on namespace ${input.namespace}.`,
          ),
        );
      }

      // 2. Run the verifier in a scratch workspace with a hard timeout. The
      //    verifier's import (AcpConformanceVerifiers) owns the child-process
      //    tree teardown; the runner relies on that contract (AC #6).
      const outcome = yield* verifier.verifies({
        namespace: input.namespace,
        capabilityId: input.capabilityId,
        runtime: input.runtimeIdentity,
        verifier: { verifierId: verifier.id },
        advertisement: input.advertised ? { advertised: true } : undefined,
        spawnContext:
          input.agentEnv !== undefined
            ? { command: input.agentCommand, env: input.agentEnv }
            : { command: input.agentCommand },
      });

      const observedAt = new Date().toISOString();
      const policy = makePolicySpec(input.policyVersion ?? CAPABILITY_EVIDENCE_POLICY_VERSION, {
        ...input.policyParams,
      });

      // 3. Persist the observation append-only (AC #3).
      const observation: CapabilityObservation = {
        observationId: `${input.namespace}:${input.capabilityId}:${observedAt}:${Math.floor(
          Math.random() * 1e8,
        )}`,
        namespace: input.namespace,
        capabilityId: input.capabilityId,
        source: CONFORMANCE_EVIDENCE_SOURCE,
        outcome: outcome.outcome,
        attribution: outcome.attribution,
        runtime: input.runtimeIdentity,
        verifier: { verifierId: verifier.id },
        policy,
        observedAt,
        run: {
          detail: outcome.detail,
          completedAt: observedAt,
        },
      };
      yield* evidence.appendObservation({ observation });

      // 4. Re-derive + upsert the effective-state cache for this capability.
      const past = yield* evidence.listObservations({
        namespace: input.namespace,
        capabilityId: input.capabilityId,
      });
      const advertisement = input.advertised
        ? { capabilityId: input.capabilityId, advertised: true, advertisedAt: observedAt }
        : undefined;
      const view = policyEngine.deriveEffectiveStateView({
        namespace: input.namespace,
        observations: past,
        policy,
        advertisement,
        derivedAt: observedAt,
      });
      yield* evidence.upsertEffectiveState({ state: view });

      const result: ConformanceRunResult = {
        observation,
        effectiveStateView: {
          capabilityId: view.capabilityId,
          state: view.state,
          advertised: view.advertised,
        },
      };
      return result;
    });

  return { run } satisfies ConformanceRunnerShape;
});

export const ConformanceRunnerLive = Layer.effect(ConformanceRunner, makeConformanceRunner);

/** Convenience entry point that runs conformance and returns the edge. */
export const runConformance = (
  input: ConformanceRunInput,
): Effect.Effect<ConformanceRunResult, Error, ConformanceRunner> =>
  Effect.gen(function* () {
    const runner = yield* ConformanceRunner;
    return yield* runner.run(input);
  });

// ─────────────────────────────────────────────────────────────────────────────
// Verifier registry composition

/** Resolves the ACP hostile fixture relative to this source file. */
export function fixturePathFromServerDir(): string {
  return path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/acp-hostile-agent.ts",
  );
}

/**
 * Registers the ACP conformance verifier bindings into the registry and
 * provides the registry service. The fixture executable path is resolved at
 * composition time.
 */
export const CapabilityVerifierRegistryLive = Layer.effect(
  CapabilityVerifierRegistry,
  Effect.gen(function* () {
    const registry = yield* makeCapabilityVerifierRegistry;
    // Register CLI verifiers first: they gate on a CLI runtime fingerprint
    // (matchesRuntime), so a `synara://cli-connector` runtime resolves here and
    // an ACP/other runtime falls through to the unguarded ACP bindings.
    makeCliVerifierRegistry({
      register: (verifier) => registry.register(verifier),
    });
    makeAcpVerifierRegistry({
      fixturePath: fixturePathFromServerDir(),
      register: (verifier) => registry.register(verifier),
    });
    return registry;
  }),
);
