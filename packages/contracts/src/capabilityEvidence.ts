import { Schema } from "effect";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { ProviderKind } from "./orchestration";

/**
 * Canonical capability identifiers for external agents.
 *
 * These are protocol-independent. Each capability names a behavior the
 * application needs from an external agent, not any particular wire method, so
 * evidence recorded for one protocol (say ACP) applies to any other runtime
 * that exposes the same behavior. KAR-524 binds real verifiers to these ids.
 */
export const CapabilityId = Schema.Literals([
  "session.start",
  "prompt",
  "stream",
  "cancel",
  "session.resume",
  "permissions",
  "elicitation",
  "tool.events",
  "model.discovery",
  "model.switch",
  "modes",
  "usage",
  "terminal.state",
]);
export type CapabilityId = typeof CapabilityId.Type;

/** The 13 canonical capability ids, kept in sync with the CapabilityId literal union. */
export const CAPABILITY_IDS: readonly CapabilityId[] = [
  "session.start",
  "prompt",
  "stream",
  "cancel",
  "session.resume",
  "permissions",
  "elicitation",
  "tool.events",
  "model.discovery",
  "model.switch",
  "modes",
  "usage",
  "terminal.state",
] as const;

/**
 * Key identifying one external agent configuration: the kind of provider
 * runtime plus the profile id that selects it. Kept as a plain namespace
 * string so the rest of the protocol-independent layer never depends on
 * ACP-specific session ids.
 */
export const ExternalAgentNamespace = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type ExternalAgentNamespace = typeof ExternalAgentNamespace.Type;

/**
 * Where an observation came from.
 *
 * - `protocol-claim`: the agent advertised it, or a protocol handshake asserted it
 * - `synthetic-conformance`: a Conformance suite exercised the behavior
 * - `production-observation`: a real user session exercised the behavior
 * - `runtime`: a live session turn outcome exercised the behavior (KAR-530)
 * - `vendor-attestation`: the agent vendor published a statement about it
 */
export const EvidenceSource = Schema.Literals([
  "protocol-claim",
  "synthetic-conformance",
  "production-observation",
  "runtime",
  "vendor-attestation",
]);
export type EvidenceSource = typeof EvidenceSource.Type;

export const EvidenceOutcome = Schema.Literals(["pass", "fail", "inconclusive"]);
export type EvidenceOutcome = typeof EvidenceOutcome.Type;

/** Who owns the failure when a capability did not verify. */
export const Attribution = Schema.Literals([
  "agent",
  "synara",
  "auth",
  "network",
  "environment",
  "unknown",
]);
export type Attribution = typeof Attribution.Type;

/**
 * The identity of the external agent runtime that produced or was observed
 * during an observation.
 *
 * Multiple independent signals because any single one can silently change
 * without meaning the whole product changed. Signal-specific staleness means
 * an upgrade to one signal marks only the evidence that referenced it as
 * provisional, never every record.
 */
export const RuntimeIdentitySignals = Schema.Struct({
  agentName: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  agentVersion: Schema.optional(Schema.String.check(Schema.isMaxLength(256))),
  protocolVersion: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  advertisedContractHash: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  resolvedEndpoint: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  resolvedCommand: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
  packageFingerprint: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  runtimeFingerprint: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type RuntimeIdentitySignals = typeof RuntimeIdentitySignals.Type;

/**
 * Identity of the verifier that produced an observation, including the shared
 * harness version. A harness change means previously recorded verification
 * outcomes may no longer hold, so policy re-derivation must fold the harness
 * version into the verifier identity.
 */
export const VerifierIdentity = Schema.Struct({
  verifierId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  harnessVersion: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
});
export type VerifierIdentity = typeof VerifierIdentity.Type;

/**
 * The policy that decided whether an observation is trustworthy. Versioned so
 * verdicts can be re-derived without re-running the observation: bump the
 * policy version, recompute `deriveEffectiveState`, and the verdict follows
 * the new calibration on the same immutable observation history.
 */
export const PolicyVersion = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type PolicyVersion = typeof PolicyVersion.Type;

export const PolicySpec = Schema.Struct({
  version: PolicyVersion,
  // Policy constants are deliberately freeform: each engine version owns how
  // it interprets them (hysteresis window, debounce, thresholds). KAR-523 pins
  // the wiring in the policy engine; KAR-524 may add more knobs.
  params: Schema.Record(Schema.String, Schema.Unknown),
});
export type PolicySpec = typeof PolicySpec.Type;

export const ObservationRunMetadata = Schema.Struct({
  threadId: Schema.optional(Schema.String),
  turnId: Schema.optional(Schema.String),
  // Protocol-level session identity if one exists (e.g. an ACP session id).
  runtimeSessionId: Schema.optional(Schema.String),
  // The external-agent profile revision that produced this run. Kept out of
  // the namespace (which aggregates evidence per profile) but recorded so the
  // observation can be audited or demoted per revision (KAR-530).
  revisionId: Schema.optional(Schema.String),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  detail: Schema.optional(Schema.String),
});
export type ObservationRunMetadata = typeof ObservationRunMetadata.Type;

/**
 * A single immutable observation of one capability. Append-only: it is never
 * edited and never represents the "current" truth about a capability. Only the
 * effective state derived from a run of observations is meaningful.
 */
export const CapabilityObservation = Schema.Struct({
  observationId: TrimmedNonEmptyString,
  namespace: ExternalAgentNamespace,
  capabilityId: CapabilityId,
  source: EvidenceSource,
  outcome: EvidenceOutcome,
  attribution: Attribution,
  runtime: RuntimeIdentitySignals,
  verifier: VerifierIdentity,
  policy: PolicySpec,
  observedAt: IsoDateTime,
  run: Schema.optional(ObservationRunMetadata),
});
export type CapabilityObservation = typeof CapabilityObservation.Type;

/** User-facing state of a capability for an external agent profile. */
export const EffectiveCapabilityState = Schema.Literals([
  // Believes the capability works (e.g. verified through conformance).
  "verified",
  // Evidence exists but is stale or its verifier/policy has changed.
  "provisional",
  // No usable evidence: either unknown to the profile or known but discarded.
  "unknown",
  // The capability is believed degraded: it works sometimes, or stalls.
  "degraded",
  // The capability is believed broken (e.g. advertised but verification failed).
  "broken",
]);
export type EffectiveCapabilityState = typeof EffectiveCapabilityState.Type;

/** One capability advertisement from a protocol-initiated capability probe. */
export const CapabilityAdvertisement = Schema.Struct({
  capabilityId: CapabilityId,
  advertised: Schema.Boolean,
  // When the protocol cannot say whether the capability is supported, `true`
  // keeps the additive-contract property: new capabilities read as unknown
  // for profiles that predate them.
  advertisedAt: IsoDateTime,
});
export type CapabilityAdvertisement = typeof CapabilityAdvertisement.Type;

/**
 * The derived effective state of one capability for one external agent profile.
 *
 * `effective` couples the user-facing verdict with the evidence that supports
 * it. `advertised` stays separate because advertisement and verification are
 * independent dimensions: `advertised: true` + `effective: "broken"` is a
 * representable, meaningful state (capability disabled), and `advertised: false`
 * + `effective: "verified"` means the agent did not claim it but it demonstrably
 * works.
 */
export const EffectiveCapabilityStateView = Schema.Struct({
  namespace: ExternalAgentNamespace,
  capabilityId: CapabilityId,
  state: EffectiveCapabilityState,
  advertised: Schema.Boolean,
  policy: PolicySpec,
  // The most recent observation that participated in the verdict, if any, plus
  // timestamps to make staleness plain to consumers.
  lastObservationAt: Schema.optional(IsoDateTime),
  lastObservationId: Schema.optional(TrimmedNonEmptyString),
  derivedAt: IsoDateTime,
});
export type EffectiveCapabilityStateView = typeof EffectiveCapabilityStateView.Type;

export const CapabilityEvidenceRecordInput = Schema.Struct({
  namespace: ExternalAgentNamespace,
  capabilityId: CapabilityId,
  source: EvidenceSource,
  outcome: EvidenceOutcome,
  attribution: Attribution,
  runtime: RuntimeIdentitySignals,
  verifier: VerifierIdentity,
  policy: PolicySpec,
  observedAt: IsoDateTime,
  run: Schema.optional(ObservationRunMetadata),
});
export type CapabilityEvidenceRecordInput = typeof CapabilityEvidenceRecordInput.Type;

export const CapabilityEvidenceQuery = Schema.Struct({
  namespace: ExternalAgentNamespace,
  capabilityId: Schema.optional(CapabilityId),
});
export type CapabilityEvidenceQuery = typeof CapabilityEvidenceQuery.Type;

export const CapabilityEvidenceQueryResult = Schema.Struct({
  observations: Schema.Array(CapabilityObservation),
  state: Schema.optional(EffectiveCapabilityStateView),
});
export type CapabilityEvidenceQueryResult = typeof CapabilityEvidenceQueryResult.Type;

/**
 * Badge lookup for one external agent profile: derive the effective capability
 * state for every capability the profile has evidence for, using the current
 * policy version. The badge is computed from the evidence store alone (KAR-530
 * AC #2), never from a mutable compatibility flag.
 */
export const CapabilityEvidenceBadge = Schema.Struct({
  namespace: ExternalAgentNamespace,
});
export type CapabilityEvidenceBadge = typeof CapabilityEvidenceBadge.Type;

export const CapabilityEvidenceBadgeResult = Schema.Struct({
  states: Schema.Array(EffectiveCapabilityStateView),
  derivedAt: IsoDateTime,
});
export type CapabilityEvidenceBadgeResult = typeof CapabilityEvidenceBadgeResult.Type;

export const CapabilityEvidenceRecordResult = Schema.Struct({
  observation: CapabilityObservation,
});
export type CapabilityEvidenceRecordResult = typeof CapabilityEvidenceRecordResult.Type;

export const CapabilityEvidenceInvalidateInput = Schema.Struct({
  namespace: ExternalAgentNamespace,
  capabilityId: Schema.optional(CapabilityId),
});
export type CapabilityEvidenceInvalidateInput = typeof CapabilityEvidenceInvalidateInput.Type;

export const CapabilityEvidenceInvalidateResult = Schema.Struct({
  invalidated: Schema.Number,
});
export type CapabilityEvidenceInvalidateResult = typeof CapabilityEvidenceInvalidateResult.Type;

/**
 * How a terminal turn outcome should affect capability evidence.
 *
 * Honest bookkeeping: a real-session observation can attest a capability
 * (`attest`), it can read as a run failure that the policy already handles
 * (`observe`), it can be marked withdrawn because the evidence a prior
 * observation claimed no longer holds (`withdraw`), or it can indicate the
 * runtime deliberately misbehaved (`abuse`). `withdraw` and `abuse` are the
 * "unsafe outcome" / "honeypot" signals that drive demotion and purge rather
 * than promotion.
 */
export const RuntimeTurnFeedbackDisposition = Schema.Literals([
  "attest",
  "observe",
  "withdraw",
  "abuse",
]);
export type RuntimeTurnFeedbackDisposition = typeof RuntimeTurnFeedbackDisposition.Type;

/**
 * Input to the runtime turn feedback recorder. Built server-side from a
 * terminal provider runtime turn event for an external-agent thread, then
 * attributed at record time to the running profile/revision.
 */
export const RuntimeTurnFeedbackInput = Schema.Struct({
  threadId: TrimmedNonEmptyString,
  turnId: Schema.optional(TrimmedNonEmptyString),
  runtimeSessionId: Schema.optional(TrimmedNonEmptyString),
  profileId: TrimmedNonEmptyString,
  revisionId: Schema.optional(TrimmedNonEmptyString),
  capabilityId: CapabilityId,
  outcome: EvidenceOutcome,
  attribution: Attribution,
  disposition: RuntimeTurnFeedbackDisposition,
  detail: Schema.optional(Schema.String),
  startedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  policyVersion: Schema.optional(TrimmedNonEmptyString),
});
export type RuntimeTurnFeedbackInput = typeof RuntimeTurnFeedbackInput.Type;

export const RuntimeTurnFeedbackResult = Schema.Struct({
  observation: CapabilityObservation,
  disposition: RuntimeTurnFeedbackDisposition,
  // How many prior observations this feedback call purged (`abuse`) or
  // demoted (`withdraw`), so callers can surface what actually happened.
  purged: Schema.optional(Schema.Number),
  demoted: Schema.optional(Schema.Number),
});
export type RuntimeTurnFeedbackResult = typeof RuntimeTurnFeedbackResult.Type;

/**
 * Batch withdrawal result: how many observations were hard-deleted (purged,
 * dishonest evidence must not survive) and how many remaining observations
 * were demoted. Both numbers are informational; consumers should trust the
 * derived effective state afterward.
 */
export const CapabilityEvidenceDemoteInput = Schema.Struct({
  namespace: ExternalAgentNamespace,
  capabilityId: Schema.optional(CapabilityId),
  decision: Schema.Literals(["purge", "demote"]),
  reason: Schema.optional(TrimmedNonEmptyString),
  observedAt: Schema.optional(IsoDateTime),
});
export type CapabilityEvidenceDemoteInput = typeof CapabilityEvidenceDemoteInput.Type;

export const CapabilityEvidenceDemoteResult = Schema.Struct({
  purged: Schema.Number,
  demoted: Schema.Number,
});
export type CapabilityEvidenceDemoteResult = typeof CapabilityEvidenceDemoteResult.Type;

export const ExternalAgentProfileId = TrimmedNonEmptyString;
export type ExternalAgentProfileId = typeof ExternalAgentProfileId.Type;

export const ExternalAgentKind = ProviderKind;
export type ExternalAgentKind = typeof ExternalAgentKind.Type;
