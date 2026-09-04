import { Effect, ServiceMap } from "effect";

import type {
  CapabilityAdvertisement,
  CapabilityObservation,
  EffectiveCapabilityState,
  EffectiveCapabilityStateView,
  PolicySpec,
} from "@synara/contracts";

/**
 * Versioned policy for deriving an effective capability state from an
 * immutable observation history.
 *
 * The engine is deliberately not self-describing; each policy version owns how
 * it maps history into a verdict. `deriveEffectiveState` is pure and
 * re-runnable: the same (observations, policyVersion) always yields the same
 * verdict, so a policy bump re-derives every profile's state without re-running
 * any observation.
 *
 * Hysteresis defaults (v1):
 * - Verdict flips only after `hysteresisConsecutive` (3) consecutive
 *   opposite-outcome observations, ignoring inconclusive ones.
 * - `inconclusiveSeenWeight` (weight 0.5) lets a sparse streak of failures
 *   surface as `degraded` rather than a hard flip while the profile is still
 *   mostly passing.
 */
export interface PolicyHysteresis {
  /** Consecutive opposite observations required before a verdict flips. */
  readonly hysteresisConsecutive: number;
  /** Weight (0..1) of an inconclusive observation for degraded detection. */
  readonly inconclusiveSeenWeight: number;
}

export const DEFAULT_POLICY_HYSTERESIS: PolicyHysteresis = {
  hysteresisConsecutive: 3,
  inconclusiveSeenWeight: 0.5,
};

/**
 * The policy version used to derive verdicts. Derived state is recomputed on
 * every query against the configured calibration, so bumping the harness
 * policy re-derives all verdicts without re-running observations (AC #5).
 */
export const CAPABILITY_EVIDENCE_POLICY_VERSION = "2026-08-16.1";

/**
 * Reads the hysteresis knobs from a `PolicySpec` under stable keys. The keys
 * live in the policy engine because the engine owns their meaning; KAR-524 may
 * tune defaults per policy version.
 */
export const readPolicyHysteresis = (policy: PolicySpec): PolicyHysteresis => {
  const raw = policy.params;
  const consecutive = Number(raw["hysteresis.consecutive"]);
  const weight = Number(raw["inconclusive.weight"]);
  return {
    hysteresisConsecutive:
      Number.isFinite(consecutive) && consecutive >= 1
        ? consecutive
        : DEFAULT_POLICY_HYSTERESIS.hysteresisConsecutive,
    inconclusiveSeenWeight:
      Number.isFinite(weight) && weight >= 0 && weight <= 1
        ? weight
        : DEFAULT_POLICY_HYSTERESIS.inconclusiveSeenWeight,
  };
};

/**
 * Builds a policy spec that any caller can embed into a recorded observation.
 * A profile with no observations should be derived with the same policy it
 * would have recorded, so its `unknown` default is stable across sessions.
 */
export const makePolicySpec = (
  version: string,
  params: Readonly<Record<string, unknown>> = {},
): PolicySpec => ({ version, params: { ...params } });

/** True when the observation's failure is explained by the run, not the agent. */
const isEnvironmental = (observation: CapabilityObservation) =>
  observation.outcome === "fail" &&
  (observation.attribution === "environment" ||
    observation.attribution === "auth" ||
    observation.attribution === "network");

/**
 * Verifier families that never signal staleness. A profile's evidence can come
 * from two different verifier *families*: conformance runs (per-capability,
 * harness-versioned ids like `prompt.acp.conformance.v<v>`) and live-session
 * runtime feedback (`runtime-turn-feedback`, KAR-530). A mixed-source profile
 * is normal and healthy — conformance measured the capability, live sessions
 * corroborated it — so cross-family verifier drift must not read `provisional`
 * forever. Staleness is only meaningful within a family.
 */
const RUNTIME_FEEDBACK_VERIFIER_FAMILIES: ReadonlySet<string> = new Set([
  "runtime-turn-feedback",
]);

const isRuntimeVerifierFamily = (verifierId: string): boolean =>
  RUNTIME_FEEDBACK_VERIFIER_FAMILIES.has(verifierId);

/** True when the observation's verifier (incl. harness version) or policy drifted from the reference. */
const isStale = (
  observation: CapabilityObservation,
  reference: CapabilityObservation,
  policyVersion: string,
) =>
  // The runtime verifier never signals staleness: live-observed evidence is
  // always current (it was just produced by the running session), so it must
  // not drag a profile's verdict to `provisional` merely because a conformance
  // run recorded under a different verifier family.
  (!isRuntimeVerifierFamily(observation.verifier.verifierId) &&
    !isRuntimeVerifierFamily(reference.verifier.verifierId) &&
    observation.verifier.verifierId !== reference.verifier.verifierId) ||
  observation.policy.version !== policyVersion;

/**
 * A pure decision function mapping an observation history to an effective
 * state for one capability of one profile.
 *
 * `protocol-claim` observations are advertisements, not verification evidence:
 * a claim asserts what the agent says it supports, but says nothing about
 * whether the behavior actually works. They never count toward `passed` or
 * `failed`, so an advertised capability with zero verification readings stays
 * `unknown` (additive default) and an advertised capability whose first
 * verification fails reads `broken` (AC #2, canonical disabled state).
 *
 * Verdict ladder (lowest → highest):
 * 1. No verification evidence for the capability → `unknown`.
 * 2. A hard failure (attributed to the agent) with no passing history → `broken`,
 *    regardless of the hysteresis window.
 * 3. The only failures are environmental/auth/network → the capability is not
 *    at fault; without any passing evidence it reads `provisional`.
 * 4. All verification evidence passes → `verified` (unless stale).
 * 5. Verifier/policy staleness → `provisional` (evidence exists but the harness
 *    or calibration changed).
 * 6. Hysteresis: a verdict only flips after `hysteresisConsecutive` consecutive
 *    opposite observations. A long trailing run of failures → `broken`, a long
 *    trailing run of passes → `verified`.
 * 7. Below the flip threshold, mixed evidence reads `degraded` — a flaky agent
 *    that mostly passes today and throws an occasional failure does not turn a
 *    working capability into a broken one every session.
 */
export function deriveEffectiveState(
  observations: ReadonlyArray<CapabilityObservation>,
  policyVersion: string,
  hyd: PolicyHysteresis = DEFAULT_POLICY_HYSTERESIS,
): EffectiveCapabilityState {
  if (observations.length === 0) return "unknown";

  // Chronological order so hysteresis "consecutive opposite" is well-defined.
  const ordered = [...observations].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const latest = ordered[ordered.length - 1]!;

  let stale = false;
  for (const observation of ordered) {
    if (isStale(observation, latest, policyVersion)) stale = true;
  }

  // Verification evidence only: protocol-claim rows are advertisements.
  const verified = ordered.filter((observation) => observation.source !== "protocol-claim");
  if (verified.length === 0) return stale ? "provisional" : "unknown";

  let passed = 0;
  let failed = 0;
  let environmentalFail = 0;

  // Trailing run of the same non-inconclusive outcome on verification evidence,
  // for hysteresis.
  let runOutcome: CapabilityObservation["outcome"] | null = null;
  let runLength = 0;
  for (let i = verified.length - 1; i >= 0; i--) {
    const outcome = verified[i]!.outcome;
    if (outcome === "inconclusive") continue;
    if (runOutcome === null) {
      runOutcome = outcome;
      runLength = 1;
    } else if (outcome === runOutcome) {
      runLength++;
    } else {
      break;
    }
  }

  for (const observation of verified) {
    switch (observation.outcome) {
      case "pass":
        passed++;
        break;
      case "fail":
        failed++;
        if (isEnvironmental(observation)) environmentalFail++;
        break;
    }
  }

  // ── Decision ladder ────────────────────────────────────────────────
  // 1. No usable verification evidence.
  if (passed === 0 && failed === 0) return "unknown";

  // 2. Hard failure with no passing history is an immediate disable.
  if (failed > environmentalFail && passed === 0) return "broken";

  // 3. Only environmental failures, no passes: capability not at fault.
  if (passed === 0 && environmentalFail === failed) return "provisional";

  // 4. All passing verification evidence. Inconclusive observations do not
  //    degrade a pass: the capability worked in every usable run.
  if (failed === 0) return stale ? "provisional" : "verified";

  // 5. Any stale evidence (harness or policy drift) degrades confidence.
  if (stale) return "provisional";

  // 6. Hysteresis flip. A verdict only flips after `hysteresisConsecutive`
  //    consecutive opposite-outcome observations, so a flaky capability that
  //    mostly passes today and throws an occasional failure is `degraded`, not
  //    disabled, and a mostly failing one needs solid recovery before it reads
  //    `verified` again.
  if (runLength >= hyd.hysteresisConsecutive && runOutcome !== null) {
    return runOutcome === "fail" ? "broken" : "verified";
  }

  // 7. Mixed evidence below the flip threshold: flaky, not broken.
  return "degraded";
}

/**
 * Derives the effective state and wraps it in the consumer-facing view,
 * including the capability advertisement explicitly separated from the verdict.
 */
export function deriveEffectiveStateView(input: {
  readonly namespace: string;
  readonly observations: ReadonlyArray<CapabilityObservation>;
  readonly policy: PolicySpec;
  readonly advertisement: CapabilityAdvertisement | undefined;
  readonly derivedAt: string;
}): EffectiveCapabilityStateView {
  const state = deriveEffectiveState(input.observations, input.policy.version);
  const latest = input.observations[input.observations.length - 1];
  return {
    namespace: input.namespace,
    capabilityId: latest?.capabilityId ?? input.advertisement?.capabilityId ?? ("" as never),
    state,
    advertised: input.advertisement?.advertised ?? false,
    policy: input.policy,
    ...(latest
      ? { lastObservationAt: latest.observedAt, lastObservationId: latest.observationId }
      : {}),
    derivedAt: input.derivedAt,
  };
}

/**
 * True when the two runtime identity signals disagree on at least one signal
 * both carry. A signal that is absent from either side is not compared, so a
 * drift in one fingerprint marks only the evidence that references it.
 */
const signalsDrifted = (
  recorded: CapabilityObservation["runtime"],
  current: CapabilityObservation["runtime"],
): boolean => {
  for (const key of Object.keys(recorded) as ReadonlyArray<
    keyof CapabilityObservation["runtime"]
  >) {
    const left = recorded[key];
    const right = current[key];
    if (left !== undefined && right !== undefined && left !== right) return true;
  }
  return false;
};

/**
 * Derives the effective state relative to the *current* runtime identity of an
 * agent (AC #6). Evidence recorded under a runtime whose shared signals no
 * longer match the current one becomes provisional rather than globally
 * blocking: `matched` observations still win their verdict from the normal
 * ladder, and if nothing matches, the remaining drifted evidence is
 * provisional — never `verified`, never `broken`.
 */
export function deriveEffectiveStateForRuntime(input: {
  readonly observations: ReadonlyArray<CapabilityObservation>;
  readonly currentRuntime: CapabilityObservation["runtime"] | undefined;
  readonly policyVersion: string;
  readonly hyd?: PolicyHysteresis;
}): EffectiveCapabilityState {
  const currentRuntime = input.currentRuntime;
  if (currentRuntime === undefined) {
    return deriveEffectiveState(input.observations, input.policyVersion, input.hyd);
  }
  const matched = input.observations.filter(
    (observation) => !signalsDrifted(observation.runtime, currentRuntime),
  );
  if (matched.length > 0) {
    return deriveEffectiveState(matched, input.policyVersion, input.hyd);
  }
  // Only drifted evidence remains: the capability reads provisional, not broken.
  return input.observations.length === 0 ? "unknown" : "provisional";
}

/**
 * Seam for the repository to persist derived states and for the service to
 * transparently re-derive. Separated from the pure function so tests can
 * inject a mock and KAR-524 can add side-channel behavior.
 */
export interface CapabilityPolicyEngineShape {
  readonly deriveEffectiveState: (
    observations: ReadonlyArray<CapabilityObservation>,
    policyVersion: string,
    hyd?: PolicyHysteresis,
  ) => EffectiveCapabilityState;
  readonly deriveEffectiveStateView: (input: {
    readonly namespace: string;
    readonly observations: ReadonlyArray<CapabilityObservation>;
    readonly policy: PolicySpec;
    readonly advertisement: CapabilityAdvertisement | undefined;
    readonly derivedAt: string;
  }) => EffectiveCapabilityStateView;
  readonly deriveEffectiveStateForRuntime: (input: {
    readonly observations: ReadonlyArray<CapabilityObservation>;
    readonly currentRuntime: CapabilityObservation["runtime"] | undefined;
    readonly policyVersion: string;
    readonly hyd?: PolicyHysteresis;
  }) => EffectiveCapabilityState;
}

export class CapabilityPolicyEngine extends ServiceMap.Service<
  CapabilityPolicyEngine,
  CapabilityPolicyEngineShape
>()("synara/capabilityEvidence/Services/CapabilityPolicyEngine") {}

export const makeCapabilityPolicyEngine = Effect.sync(
  (): CapabilityPolicyEngineShape => ({
    deriveEffectiveState,
    deriveEffectiveStateView,
    deriveEffectiveStateForRuntime,
  }),
);
