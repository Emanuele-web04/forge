// FILE: ProfileLifecycleService.ts
// Purpose: KAR-529 external agent profile lifecycle: a state machine over
// (active | quarantined | retired) with provenance-based trust evaluation,
// evidence-freshness re-certification, and strict quarantine that kills live
// sessions. One service, four responsibilities:
//   - evaluateTrust: deterministic verdict from revision provenance + claims
//   - quarantineProfile / unquarantineProfile: state transitions that also
//     stop live provider sessions for the profile
//   - recertifyProfile: evidence-freshness check + conformance re-runs +
//     downgrade/quarantine decision
//   - assertSessionAllowed: delegates to the shared pure launch gate in
//     agentProfileTrust.ts, which resolveSessionLaunch also calls — one source
//     of truth for "may this session start" (status + trust rules).
// Layer: Server external agents
// Exports: ProfileLifecycleService, makeProfileLifecycleService,
//          recertifyDecisionFromStates

import { CAPABILITY_IDS } from "@synara/contracts";
import type {
  AgentProfile,
  AgentProfileLifecycleEvent,
  AgentProfileRevision,
  AgentProfileStatus,
  AgentProfileTrust,
  CapabilityId,
} from "@synara/contracts";
import { Data, Effect, Layer, Option, ServiceMap } from "effect";

import { CapabilityEvidenceService } from "../capabilityEvidence/Services/CapabilityEvidenceService.ts";
import { ConformanceRunner } from "../conformance/ConformanceRunner.ts";
import {
  ProviderSessionDirectory,
  type ProviderRuntimeBinding,
} from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { AgentProfileRepository } from "./AgentProfileRepository.ts";
import {
  assertSessionAllowed as assertSessionAllowedGate,
  profileEvidenceNamespace,
  ProfileSessionRefused,
} from "./agentProfileTrust.ts";
import { isAgentProfileRevisionTrusted } from "./agentProfileTrust.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Errors

export class ProfileLifecycleError extends Data.TaggedError("ProfileLifecycleError")<{
  readonly code:
    | "profile-not-found"
    | "invalid-transition"
    | "quarantine-stop-failed"
    | "recertify-failed"
    | "internal";
  readonly message: string;
  readonly status?: 400 | 404 | 409 | 500;
  readonly cause?: unknown;
}> {}

const notFoundError = (profileId: string) =>
  new ProfileLifecycleError({
    code: "profile-not-found",
    message: `External agent profile "${profileId}" does not exist.`,
    status: 404,
  });

const invalidTransitionError = (from: AgentProfileStatus, to: string, why: string) =>
  new ProfileLifecycleError({
    code: "invalid-transition",
    message: `External agent profile cannot move ${from} → ${to}: ${why}`,
    status: 409,
  });

const internalError = (operation: string) => (cause: unknown) =>
  new ProfileLifecycleError({
    code: "internal",
    message: `External agent profile lifecycle ${operation} failed.`,
    status: 500,
    cause,
  });

// ─────────────────────────────────────────────────────────────────────────────
// Decision primitive (pure)

/**
 * Reduces per-capability effective states to a lifecycle decision after a
 * re-certification pass. A broken capability is the downgrade signal: it means
 * the agent demonstrably fails a behavior it advertised, so the profile is
 * quarantined until fixed.
 */
export function recertifyDecisionFromStates(input: {
  readonly states: Readonly<Record<string, string>>;
}): {
  readonly shouldQuarantine: boolean;
  readonly brokenCapabilities: ReadonlyArray<CapabilityId>;
} {
  const broken = (Object.keys(input.states) as CapabilityId[]).filter(
    (capabilityId) => input.states[capabilityId] === "broken",
  );
  return {
    shouldQuarantine: broken.length > 0,
    brokenCapabilities: broken,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Service shape

export interface ProfileLifecycleServiceShape {
  /**
   * Deterministic trust evaluation for the profile's pinned revision, computed
   * from provenance + trust claims. Persists the effective trust alongside.
   */
  readonly evaluateTrust: (profileId: string) => Effect.Effect<AgentProfile, ProfileLifecycleError>;
  /**
   * Transition a profile into quarantine: assigns the quarantine lifecycle
   * event, kills every running provider session bound to this profile, and
   * blocks new sessions.
   */
  readonly quarantineProfile: (
    profileId: string,
    input?: {
      readonly reason?: string;
    },
  ) => Effect.Effect<
    { readonly profile: AgentProfile; readonly stoppedSessions: number },
    ProfileLifecycleError
  >;
  /** Lift a quarantine back into active (operator override; re-certify later). */
  readonly unquarantineProfile: (
    profileId: string,
    input?: {
      readonly reason?: string;
    },
  ) => Effect.Effect<AgentProfile, ProfileLifecycleError>;
  /**
   * Re-certification: query evidence freshness per capability, re-run
   * conformance for stale/unknown capabilities, derive effective states, then
   * downgrade (quarantine) or keep active.
   */
  readonly recertifyProfile: (
    profileId: string,
    input?: {
      readonly reason?: string;
    },
  ) => Effect.Effect<
    { readonly profile: AgentProfile; readonly states: Readonly<Record<string, string>> },
    ProfileLifecycleError
  >;
  /**
   * Gate consulted before session launch / credential release. Refuses when
   * quarantined/retired and when an active profile is untrusted but needs
   * credential release (provenance-based trust).
   */
  readonly assertSessionAllowed: (input: {
    readonly profile: AgentProfile;
    readonly revision: AgentProfileRevision;
  }) => Effect.Effect<void, Error>;
}

export class ProfileLifecycleService extends ServiceMap.Service<
  ProfileLifecycleService,
  ProfileLifecycleServiceShape
>()("synara/externalAgents/ProfileLifecycleService") {}

// ─────────────────────────────────────────────────────────────────────────────
// Implementation

const lifecycleEvent = (
  kind: AgentProfileLifecycleEvent["kind"],
  reason: string,
): AgentProfileLifecycleEvent => ({
  kind,
  reason,
  observedAt: new Date().toISOString(),
});

const makeProfileLifecycleService = Effect.gen(function* () {
  const repository = yield* AgentProfileRepository;
  const evidenceService = yield* CapabilityEvidenceService;
  const conformanceRunner = yield* ConformanceRunner;
  const providerService = yield* ProviderService;
  const sessionDirectory = yield* ProviderSessionDirectory;

  const getProfile = (profileId: string) =>
    repository
      .getProfile(profileId)
      .pipe(Effect.mapError(internalError("getProfile")))
      .pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () => Effect.fail(notFoundError(profileId)),
            onSome: (profile) => Effect.succeed(profile),
          }),
        ),
      );

  const getRevision = (revisionId: string) =>
    repository
      .getRevision(revisionId)
      .pipe(Effect.mapError(internalError("getRevision")))
      .pipe(
        Effect.flatMap((option) =>
          Option.match(option, {
            onNone: () =>
              Effect.fail(
                new ProfileLifecycleError({
                  code: "internal",
                  message: `External agent profile references unknown revision "${revisionId}".`,
                  status: 500,
                }),
              ),
            onSome: (revision) => Effect.succeed(revision),
          }),
        ),
      );

  const stopSessionsForProfile = (profileId: string): Effect.Effect<number, Error> =>
    Effect.gen(function* () {
      // Find threads bound to this profile two ways: live sessions whose
      // resume cursor records the pinning profile, and persisted runtime
      // bindings whose model selection is external for this profile. The
      // second catches sessions that never got a native cursor (e.g. failed
      // starts), which still must not keep running after quarantine.
      const sessions = yield* providerService.listSessions();
      const bindings = yield* sessionDirectory
        .listBindings()
        .pipe(Effect.catch(() => Effect.succeed([] as ProviderRuntimeBinding[])));
      const boundByCursor = new Set(
        sessions.flatMap((session) => {
          const payload = session.resumeCursor as
            | { readonly profileId?: string }
            | null
            | undefined;
          return payload?.profileId === profileId ? [session.threadId] : [];
        }),
      );
      const boundByModelSelection = new Set(
        bindings.flatMap((binding) => {
          const payload = binding.runtimePayload as
            | { readonly modelSelection?: { provider?: string; profileId?: string } }
            | null
            | undefined;
          return payload?.modelSelection?.provider === "external" &&
            payload.modelSelection.profileId === profileId
            ? [binding.threadId]
            : [];
        }),
      );
      const threadIds = new Set([...boundByCursor, ...boundByModelSelection]);
      let stopped = 0;
      const stopFailures: Array<{ readonly threadId: string; readonly cause: unknown }> = [];
      for (const threadId of threadIds) {
        yield* providerService.stopSession({ threadId }).pipe(
          Effect.match({
            onFailure: (cause) => {
              stopFailures.push({ threadId, cause });
            },
            onSuccess: () => {
              stopped += 1;
            },
          }),
        );
      }
      // Surface only actual stop failures; a session that fails to stop is a
      // safety miss (its runtime may still run after quarantine). Log the
      // failure while keeping the count to successes only.
      if (stopFailures.length > 0) {
        yield* Effect.logError("Failed to stop sessions bound to an external agent profile").pipe(
          Effect.annotateLogs({
            profileId,
            failures: stopFailures.map(
              (failure) => `${failure.threadId}: ${String(failure.cause)}`,
            ),
          }),
        );
      }
      return stopped;
    });

  const evaluateTrust: ProfileLifecycleServiceShape["evaluateTrust"] = (profileId) =>
    Effect.gen(function* () {
      const profile = yield* getProfile(profileId);
      const revision = yield* getRevision(profile.currentRevisionId);
      const trust: AgentProfileTrust | null = isAgentProfileRevisionTrusted(revision)
        ? {
            workflows: revision.trust?.workflows ?? [],
            brands: revision.trust?.brands ?? [],
            organizations: revision.trust?.organizations ?? [],
          }
        : null;
      const updated = yield* repository
        .setTrust({
          profileId,
          trust,
          updatedAt: new Date().toISOString(),
        })
        .pipe(Effect.mapError(internalError("evaluateTrust")));
      return yield* Option.match(updated, {
        onNone: () => Effect.fail(notFoundError(profileId)),
        onSome: (value) => Effect.succeed(value),
      });
    });

  const quarantineProfile: ProfileLifecycleServiceShape["quarantineProfile"] = (profileId, input) =>
    Effect.gen(function* () {
      const profile = yield* getProfile(profileId);
      if (profile.status === "retired") {
        return yield* Effect.fail(
          invalidTransitionError(
            "retired",
            "quarantined",
            "a retired profile cannot be quarantined",
          ),
        );
      }
      const reason = input?.reason ?? "Quarantined by operator";
      let stopped = 0;
      if (profile.status !== "quarantined") {
        yield* repository
          .setLifecycleState({
            profileId,
            status: "quarantined",
            updatedAt: new Date().toISOString(),
            lifecycleEvent: lifecycleEvent("quarantine", reason),
          })
          .pipe(Effect.mapError(internalError("quarantineProfile")));
      }
      // Always stop live sessions, including on re-quarantine, to heal any
      // session that slipped in between the first quarantine and now.
      stopped = yield* stopSessionsForProfile(profileId).pipe(
        Effect.mapError(
          (cause) =>
            new ProfileLifecycleError({
              code: "quarantine-stop-failed",
              message: `Failed to stop live sessions for profile "${profile.name}".`,
              status: 500,
              cause,
            }),
        ),
      );
      const updated = yield* getProfile(profileId);
      return { profile: updated, stoppedSessions: stopped };
    });

  const unquarantineProfile: ProfileLifecycleServiceShape["unquarantineProfile"] = (
    profileId,
    input,
  ) =>
    Effect.gen(function* () {
      const profile = yield* getProfile(profileId);
      if (profile.status === "retired") {
        return yield* Effect.fail(
          invalidTransitionError("retired", "active", "a retired profile cannot be un-quarantined"),
        );
      }
      if (profile.status !== "quarantined") {
        return yield* Effect.fail(
          invalidTransitionError(
            profile.status,
            "active",
            "only a quarantined profile can be un-quarantined",
          ),
        );
      }
      const reason =
        input?.reason ?? "Operator un-quarantined (manual override; re-certify to restore trust)";
      const updated = yield* repository
        .setLifecycleState({
          profileId,
          status: "active",
          updatedAt: new Date().toISOString(),
          lifecycleEvent: lifecycleEvent("re-certify", reason),
        })
        .pipe(Effect.mapError(internalError("unquarantineProfile")));
      return yield* Option.match(updated, {
        onNone: () => Effect.fail(notFoundError(profileId)),
        onSome: (value) => Effect.succeed(value),
      });
    });

  const recertifyProfile: ProfileLifecycleServiceShape["recertifyProfile"] = (profileId, input) =>
    Effect.gen(function* () {
      const profile = yield* getProfile(profileId);
      if (profile.status === "retired") {
        return yield* Effect.fail(
          invalidTransitionError(
            "retired",
            "re-certify",
            "a retired profile cannot be re-certified",
          ),
        );
      }
      const revision = yield* getRevision(profile.currentRevisionId);
      const namespace = profileEvidenceNamespace(profileId);

      // 1. Current evidence freshness per capability.
      const existingStates = new Map<CapabilityId, string>();
      for (const capabilityId of CAPABILITY_IDS) {
        const query = yield* evidenceService
          .query({ namespace, capabilityId })
          .pipe(Effect.mapError(internalError("recertifyProfile:query")));
        existingStates.set(capabilityId, query.state?.state ?? "unknown");
      }

      // 2. Re-run conformance for capabilities that are unknown/stale so the
      //    re-certification cadence re-establishes evidence. Fresh evidence
      //    stays put. Endpoint-launch profiles cannot be re-run; keep existing.
      const states: Record<string, string> = {};
      for (const capabilityId of CAPABILITY_IDS) {
        const current = existingStates.get(capabilityId) ?? "unknown";
        if (current !== "unknown" && current !== "provisional") {
          states[capabilityId] = current;
          continue;
        }
        if (revision.launch.kind !== "command") {
          states[capabilityId] = current;
          continue;
        }
        const runResult = yield* conformanceRunner
          .run({
            namespace,
            capabilityId,
            runtimeIdentity: {
              agentName: revision.displayName,
              agentVersion: revision.provenance.version,
              resolvedCommand: revision.launch.command,
            },
            agentCommand: revision.launch.command,
            advertised: true,
          })
          .pipe(
            Effect.match({
              onFailure: () => null,
              onSuccess: (result) => result.effectiveStateView.state,
            }),
          );
        states[capabilityId] = runResult ?? current;
      }

      // 3. Re-derive the whole view set from the (post-run) observation history
      //    so the reported states and the persisted cache agree.
      for (const capabilityId of CAPABILITY_IDS) {
        const query = yield* evidenceService
          .query({ namespace, capabilityId })
          .pipe(Effect.mapError(internalError("recertifyProfile:re-derive")));
        if (query.state) states[capabilityId] = query.state.state;
      }

      // 4. Downgrade decision.
      const decision = recertifyDecisionFromStates({ states });
      const nextStatus: AgentProfileStatus = decision.shouldQuarantine ? "quarantined" : "active";
      const observedAt = new Date().toISOString();
      const reason = decision.shouldQuarantine
        ? `Re-certification found broken capability(ies): ${decision.brokenCapabilities.join(", ")}`
        : (input?.reason ?? "Re-certification passed; evidence refreshed");

      yield* repository
        .setLifecycleState({
          profileId,
          status: nextStatus,
          updatedAt: observedAt,
          lifecycleEvent: lifecycleEvent("re-certify", reason),
        })
        .pipe(Effect.mapError(internalError("recertifyProfile:persist")));

      // If we quarantined, kill live sessions for the profile now. A stop
      // failure here leaves a session running against a quarantined profile —
      // a safety miss that must not be silently swallowed. Log it and surface
      // the same `quarantine-stop-failed` outcome quarantineProfile reports,
      // so the caller sees the kill failed even though the state was already
      // persisted to quarantined.
      if (decision.shouldQuarantine) {
        yield* stopSessionsForProfile(profileId).pipe(
          Effect.tapError((cause) =>
            Effect.logError(
              "Re-certification quarantined a profile but failed to stop its live sessions",
            ).pipe(Effect.annotateLogs({ profileId, cause: String(cause) })),
          ),
          Effect.mapError(
            (cause) =>
              new ProfileLifecycleError({
                code: "quarantine-stop-failed",
                message: `Re-certification quarantined profile "${profile.name}" but failed to stop its live sessions.`,
                status: 500,
                cause,
              }),
          ),
        );
      }

      // Re-run trust evaluation so the persisted trust reflects the pinned
      // revision as of the re-certification.
      const withTrust = yield* evaluateTrust(profileId);
      return { profile: withTrust, states };
    });

  const assertSessionAllowed: ProfileLifecycleServiceShape["assertSessionAllowed"] = (input) =>
    // Delegates to the shared pure gate (agentProfileTrust.ts) — the same
    // gate resolveSessionLaunch calls, so the status + trust rules live in
    // exactly one place. `Effect.try` keeps the thrown ProfileSessionRefused on
    // the error channel instead of letting it escape a generator try/catch.
    Effect.try({
      try: () => assertSessionAllowedGate(input),
      catch: (cause) =>
        cause instanceof ProfileSessionRefused
          ? new Error(cause.message)
          : cause instanceof Error
            ? cause
            : new Error(String(cause)),
    });

  return {
    evaluateTrust,
    quarantineProfile,
    unquarantineProfile,
    recertifyProfile,
    assertSessionAllowed,
  } satisfies ProfileLifecycleServiceShape;
});

export const ProfileLifecycleServiceLive = Layer.effect(
  ProfileLifecycleService,
  makeProfileLifecycleService,
);
