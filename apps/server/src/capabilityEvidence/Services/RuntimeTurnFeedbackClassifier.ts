// FILE: RuntimeTurnFeedbackClassifier.ts
// Purpose: Pure classification of a terminal live-session turn into the
// capability-evidence disposition that the runtime feedback service should
// honor (KAR-530). Kept as a pure function so the same decision both powers
// the server-side ingestion hook and is unit-testable in isolation: the
// honeypot (induced faults → deliberate abuse) and unsafe-outcome paths must
// never be able to *promote* evidence — only purge or demote it.
// Layer: Server capability-evidence feedback
// Exports: RUNTIME_FEEDBACK_VERIFIER_ID, classifyRuntimeTurnAttribution,
//          classifyRuntimeTurnDisposition, classifyRuntimeTurnFeedbackInput

import type { Attribution, EvidenceOutcome } from "@synara/contracts";

import type { RuntimeTurnFeedbackDisposition } from "@synara/contracts";

/**
 * Verifier identity used for runtime-observed evidence. Separate from the
 * conformance harness identity so policy staleness (verifier drift) treats
 * live-observed behavior independently of measured behavior.
 */
export const RUNTIME_FEEDBACK_VERIFIER_ID = "runtime-turn-feedback";

/** Signal exposed by a terminal provider-runtime turn. */
export interface RuntimeTurnFeedbackTurnSignals {
  readonly turnState: "completed" | "failed" | "interrupted" | "cancelled";
  readonly errorMessage?: string | null | undefined;
  readonly stopReason?: string | null | undefined;
}

const ATTRIBUTABLE_FAILURE_MARKERS: ReadonlyArray<RegExp> = [
  /auth/i,
  /credential/i,
  /token/i,
  /network/i,
  /timeout/i,
  /timed out/i,
  /environment/i,
  /sandbox/i,
  /disk/i,
  /out of memory/i,
];

/**
 * Normalizes an agent-attributable turn failure into an `Attribution`. A
 * message that looks environmental (auth/network/timeout) keeps the capability
 * out of global demotion — it reads inconclusive, never a hard agent failure.
 * Anything else is the agent's responsibility.
 */
export function classifyRuntimeTurnAttribution(
  errorMessage: string | null | undefined,
): Attribution {
  if (errorMessage == null || errorMessage.trim().length === 0) {
    return "unknown";
  }
  return ATTRIBUTABLE_FAILURE_MARKERS.some((marker) => marker.test(errorMessage))
    ? "environment"
    : "agent";
}

/**
 * Maps a terminal turn to the evidence disposition:
 *
 * - `completed` → `attest`: the turn exercised the capability successfully.
 * - `interrupted`/`cancelled` → `observe`: inconclusive, inert in the policy.
 * - `failed` → `withdraw` when the failure is agent-attributable (an honest
 *   unsafe outcome: the capability did not hold), else `observe` when it could
 *   be environmental — never a global `broken`.
 * - `abuse` (honeypot) is never inferred from success/failure alone: callers
 *   pass it explicitly when an induced fault revealed deliberate misuse.
 */
export function classifyRuntimeTurnDisposition(
  signals: RuntimeTurnFeedbackTurnSignals,
): RuntimeTurnFeedbackDisposition {
  switch (signals.turnState) {
    case "completed":
      return "attest";
    case "interrupted":
    case "cancelled":
      return "observe";
    case "failed":
      return classifyRuntimeTurnAttribution(signals.errorMessage) === "agent"
        ? "withdraw"
        : "observe";
    default: {
      // A new turnState must be handled explicitly before this is reachable.
      const exhaustive: never = signals.turnState;
      return exhaustive;
    }
  }
}

/** The pure evidence input a terminal turn maps to, before service-side persistence. */
export interface RuntimeTurnFeedbackInputShadow {
  readonly outcome: EvidenceOutcome;
  readonly attribution: Attribution;
  readonly disposition: RuntimeTurnFeedbackDisposition;
}

/**
 * Builds the evidence shadow for a terminal turn. Completed turns attest; a
 * failed, agent-attributable turn records a withdraw with an *inconclusive*
 * hardening reading (the honest bookkeeping is "the capability did not hold
 * this time" — that withdraws prior claims but never fabricates a hard agent
 * failure that the policy would read as `broken`); a failed but
 * possibly-environmental turn records inconclusive and observes;
 * interrupted/cancelled turns record inconclusive too — they do not promote
 * and must not globally punish.
 * Honeypot turns arrive with an explicit `honeypot` flag; the caller then owns
 * the `abuse` disposition (see classifyRuntimeTurnDisposition), which the
 * service turns into a purge — never a promotion.
 */
export function classifyRuntimeTurnFeedbackInput(
  signals: RuntimeTurnFeedbackTurnSignals,
  honeypot?: boolean,
): RuntimeTurnFeedbackInputShadow {
  if (honeypot === true) {
    return { outcome: "fail", attribution: "agent", disposition: "abuse" };
  }
  switch (signals.turnState) {
    case "completed":
      return { outcome: "pass", attribution: "agent", disposition: "attest" };
    case "failed": {
      const attribution = classifyRuntimeTurnAttribution(signals.errorMessage);
      return attribution === "agent"
        ? { outcome: "inconclusive", attribution, disposition: "withdraw" }
        : { outcome: "inconclusive", attribution, disposition: "observe" };
    }
    case "interrupted":
    case "cancelled":
      return { outcome: "inconclusive", attribution: "unknown", disposition: "observe" };
    default: {
      // A new turnState must be handled explicitly before this is reachable.
      const exhaustive: never = signals.turnState;
      return exhaustive;
    }
  }
}
