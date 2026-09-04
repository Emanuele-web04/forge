import type {
  AgentProfile,
  AgentProfileCredentialRef,
  AgentProfileRevision,
  ExternalAgentProfileCreateInput,
  ExternalAgentProfileCreateResult,
  ExternalAgentProfileGetResult,
  ExternalAgentProfileUpdateInput,
  ExternalAgentProfileUpdateResult,
} from "@synara/contracts";
import {
  AgentProfileId,
  CLI_CONNECTOR_MAPPING_ERROR_MESSAGE,
  validateCliConnectorMapping,
} from "@synara/contracts";
import { Data, Effect, Layer, Option, ServiceMap } from "effect";
import { randomUUID } from "node:crypto";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore";
import {
  computeAgentProfileContentHash,
  computeAgentProfileRevisionId,
  legacyAcpProfileId,
  legacyAcpRevisionContent,
  legacyAcpRevisionId,
} from "./agentProfileIdentity";
import { AgentProfileRepository, type AgentProfileRepositoryShape } from "./AgentProfileRepository";
import { assertSessionAllowed, ProfileSessionRefused } from "./agentProfileTrust";

export class ExternalAgentProfileError extends Data.TaggedError("ExternalAgentProfileError")<{
  readonly code: string;
  readonly message: string;
  readonly status?: 400 | 404 | 409 | 500;
  readonly cause?: unknown;
}> {}

export interface ExternalAgentSessionLaunch {
  readonly profile: AgentProfile;
  readonly revision: AgentProfileRevision;
  /** Resolved launch environment: credential env keys to values. */
  readonly env: Readonly<Record<string, string>>;
}

export interface AgentProfileServiceShape {
  readonly listProfiles: () => Effect.Effect<
    ReadonlyArray<AgentProfile>,
    ExternalAgentProfileError
  >;
  readonly getProfile: (
    profileId: string,
  ) => Effect.Effect<ExternalAgentProfileGetResult, ExternalAgentProfileError>;
  readonly createProfile: (
    input: ExternalAgentProfileCreateInput,
  ) => Effect.Effect<ExternalAgentProfileCreateResult, ExternalAgentProfileError>;
  readonly updateProfile: (
    input: ExternalAgentProfileUpdateInput,
  ) => Effect.Effect<ExternalAgentProfileUpdateResult, ExternalAgentProfileError>;
  readonly tombstoneProfile: (
    profileId: string,
  ) => Effect.Effect<AgentProfile, ExternalAgentProfileError>;
  /**
   * Resolves the pinned revision for a session start: profile must exist and
   * be active, the referenced revision must exist, and credential references
   * are expanded from the server secret store. Never returns raw secrets in
   * profile metadata; only the resolved launch environment.
   */
  readonly resolveSessionLaunch: (input: {
    readonly profileId: string;
    readonly revisionId: string;
  }) => Effect.Effect<ExternalAgentSessionLaunch, ExternalAgentProfileError, ServerSecretStore>;
  /**
   * Creates the canonical legacy generic-ACP profile (idempotent) so persisted
   * provider:"acp" state always resolves to one deterministic external profile.
   */
  readonly ensureLegacyAcpProfile: () => Effect.Effect<AgentProfile, ExternalAgentProfileError>;
}

export class AgentProfileService extends ServiceMap.Service<
  AgentProfileService,
  AgentProfileServiceShape
>()("synara/externalAgents/AgentProfileService") {}

const profileSecretName = (profileId: string, refName: string) =>
  `external-agent-profile:${profileId}:${refName}`;

const profileNotFoundError = (profileId: string) =>
  new ExternalAgentProfileError({
    code: "profile-not-found",
    message: `External agent profile "${profileId}" does not exist.`,
    status: 404,
  });

const revisionNotFoundError = (profileName: string, revisionId: string) =>
  new ExternalAgentProfileError({
    code: "revision-not-found",
    message: `External agent profile "${profileName}" references unknown revision "${revisionId}".`,
    status: 404,
  });

const profileRemovedError = (profileName: string) =>
  new ExternalAgentProfileError({
    code: "profile-removed",
    message: `External agent profile "${profileName}" has been removed; new sessions are disabled.`,
    status: 409,
  });

function buildContentFromEdit(input: {
  readonly displayName: string;
  readonly connectorKind: AgentProfileRevision["connectorKind"];
  readonly launch: AgentProfileRevision["launch"];
  readonly credentialRefs: ReadonlyArray<AgentProfileCredentialRef>;
  readonly provenance: AgentProfileRevision["provenance"];
  readonly trust?: AgentProfileRevision["trust"];
}) {
  return {
    displayName: input.displayName,
    connectorKind: input.connectorKind,
    launch: input.launch,
    credentialRefs: input.credentialRefs,
    provenance: input.provenance,
    ...(input.trust !== undefined ? { trust: input.trust } : {}),
  };
}

export const makeAgentProfileService = Effect.gen(function* () {
  const repository = yield* AgentProfileRepository;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const ensureLegacyAcpProfile: AgentProfileServiceShape["ensureLegacyAcpProfile"] = () =>
    Effect.gen(function* () {
      const existing = yield* repository.getProfile(legacyAcpProfileId());
      if (Option.isSome(existing)) {
        return existing.value;
      }
      const now = new Date().toISOString();
      const content = legacyAcpRevisionContent();
      const revisionId = legacyAcpRevisionId();
      const revision: AgentProfileRevision = {
        revisionId,
        displayName: content.displayName,
        connectorKind: content.connectorKind,
        launch: content.launch,
        credentialRefs: content.credentialRefs,
        provenance: content.provenance,
        createdAt: now,
      };
      const profile: AgentProfile = {
        profileId: legacyAcpProfileId(),
        name: "Legacy ACP Agent",
        currentRevisionId: revisionId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      yield* repository.createProfile({
        profile,
        revision,
        contentHash: computeAgentProfileContentHash(content),
      });
      return profile;
    }).pipe(Effect.mapError(toServiceError("ensureLegacyAcpProfile")));

  const resolveCredentialEnv = (
    profile: AgentProfile,
    revision: AgentProfileRevision,
  ): Effect.Effect<
    Readonly<Record<string, string>>,
    ExternalAgentProfileError,
    ServerSecretStore
  > =>
    Effect.gen(function* () {
      const secrets = yield* ServerSecretStore;
      const launchRefs = revision.launch.kind === "command" ? (revision.launch.envRefs ?? []) : [];
      // Launch env refs win over revision-level refs for the same env key; both
      // resolve from the same profile-scoped secret name.
      const refByEnvKey = new Map<string, AgentProfileCredentialRef>();
      for (const ref of revision.credentialRefs ?? []) {
        refByEnvKey.set(ref.envKey, ref);
      }
      for (const ref of launchRefs) {
        refByEnvKey.set(ref.envKey, ref);
      }
      const env: Record<string, string> = {};
      for (const [envKey, ref] of refByEnvKey) {
        const secret = yield* secrets.get(profileSecretName(profile.profileId, ref.name)).pipe(
          Effect.mapError(
            (cause) =>
              new ExternalAgentProfileError({
                code: "secret-store",
                message: "Failed to read an external agent profile credential.",
                status: 500,
                cause,
              }),
          ),
        );
        if (secret === null || secret.byteLength === 0) {
          if (ref.required) {
            return yield* new ExternalAgentProfileError({
              code: "missing-credential",
              message: `External agent profile "${profile.name}" requires credential "${ref.name}", which is not configured.`,
              status: 400,
            });
          }
          continue;
        }
        try {
          env[envKey] = decoder.decode(secret);
        } catch {
          return yield* new ExternalAgentProfileError({
            code: "invalid-credential",
            message: `External agent profile "${profile.name}" credential "${ref.name}" is not valid UTF-8 text.`,
            status: 400,
          });
        }
      }
      return env;
    });

  const resolveSessionLaunch: AgentProfileServiceShape["resolveSessionLaunch"] = (input) =>
    Effect.gen(function* () {
      let profile = yield* repository.getProfile(input.profileId);
      if (Option.isNone(profile) && input.profileId === legacyAcpProfileId()) {
        yield* ensureLegacyAcpProfile();
        profile = yield* repository.getProfile(input.profileId);
      }
      if (Option.isNone(profile)) {
        return yield* profileNotFoundError(input.profileId);
      }
      const current = profile.value;
      const revision = yield* repository.getRevision(input.revisionId);
      if (Option.isNone(revision)) {
        return yield* revisionNotFoundError(current.name, input.revisionId);
      }
      // Shared launch gate (KAR-529 AC5): refuses quarantined/retired profiles
      // and untrusted credential release — the same trust/status rules the
      // lifecycle service's assertSessionAllowed enforces. `Effect.try` keeps
      // the thrown ProfileSessionRefused on the error channel.
      const refusal = yield* Effect.try({
        try: () => assertSessionAllowed({ profile: current, revision: revision.value }),
        catch: (cause) =>
          cause instanceof ProfileSessionRefused
            ? cause
            : cause instanceof Error
              ? cause
              : new Error(String(cause)),
      }).pipe(
        Effect.match({
          onFailure: (cause) =>
            cause instanceof ProfileSessionRefused ? Option.some(cause) : Option.none(),
          onSuccess: () => Option.none<ProfileSessionRefused>(),
        }),
      );
      if (Option.isSome(refusal)) {
        return yield* Effect.fail(
          new ExternalAgentProfileError({
            code: refusal.value.code,
            message: refusal.value.message,
            status: 409,
          }),
        );
      }
      const env = yield* resolveCredentialEnv(current, revision.value);
      return { profile: current, revision: revision.value, env };
    }).pipe(Effect.mapError(toServiceError("resolveSessionLaunch")));

  const listProfiles: AgentProfileServiceShape["listProfiles"] = () =>
    repository.listProfiles().pipe(Effect.mapError(toServiceError("listProfiles")));

  const getProfile: AgentProfileServiceShape["getProfile"] = (profileId) =>
    Effect.gen(function* () {
      const profile = yield* repository.getProfile(profileId);
      if (Option.isNone(profile)) {
        return yield* profileNotFoundError(profileId);
      }
      const revisions = yield* repository.getProfileRevisions(profileId);
      const currentRevision = revisions[0];
      if (!currentRevision) {
        return yield* new ExternalAgentProfileError({
          code: "revision-not-found",
          message: `External agent profile "${profile.value.name}" has no current revision.`,
          status: 500,
        });
      }
      return { profile: profile.value, currentRevision, revisions };
    }).pipe(Effect.mapError(toServiceError("getProfile")));

  const createProfile: AgentProfileServiceShape["createProfile"] = (input) =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const profileId = AgentProfileId.makeUnsafe(`agentprofile_${randomUUID()}`);
      const provenance = input.provenance ?? { source: "manual" };
      const content = buildContentFromEdit({
        displayName: input.displayName,
        connectorKind: input.connectorKind,
        launch: input.launch,
        credentialRefs: input.credentialRefs ?? [],
        provenance,
      });
      const revisionId = computeAgentProfileRevisionId(content);
      const revision: AgentProfileRevision = {
        revisionId,
        displayName: input.displayName,
        connectorKind: input.connectorKind,
        launch: input.launch,
        credentialRefs: input.credentialRefs ?? [],
        provenance,
        createdAt: now,
      };
      const profile: AgentProfile = {
        profileId,
        name: input.name,
        currentRevisionId: revisionId,
        status: "active",
        createdAt: now,
        updatedAt: now,
      };
      const { revisionReused } = yield* repository.createProfile({
        profile,
        revision,
        contentHash: computeAgentProfileContentHash(content),
      });
      return { profile, revision, reused: revisionReused };
    }).pipe(Effect.mapError(toServiceError("createProfile")));

  const updateProfile: AgentProfileServiceShape["updateProfile"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository.getProfile(input.profileId);
      if (Option.isNone(existing)) {
        return yield* profileNotFoundError(input.profileId);
      }
      const profile = existing.value;
      if (profile.status === "retired") {
        return yield* profileRemovedError(profile.name);
      }
      const currentRevision = yield* repository.getRevision(profile.currentRevisionId);
      const connectorKind = Option.isSome(currentRevision)
        ? currentRevision.value.connectorKind
        : "acp";
      // The update input does not carry `connectorKind`; the kind is preserved
      // from the current revision. The create-input schema rejects bad
      // cli-kind↔launch mappings, but the update path rebuilds the revision
      // in memory and persists raw JSON, so re-check the preserved kind against
      // the incoming launch here. This mirrors the schema refinement and keeps
      // a profile from silently drifting into a contradictory launch shape.
      if (
        !validateCliConnectorMapping({
          connectorKind,
          launch: input.launch,
        })
      ) {
        return yield* new ExternalAgentProfileError({
          code: "invalid-connector-mapping",
          message: CLI_CONNECTOR_MAPPING_ERROR_MESSAGE,
          status: 400,
        });
      }
      const previousProvenance = Option.isSome(currentRevision)
        ? currentRevision.value.provenance
        : undefined;
      const now = new Date().toISOString();
      const content = buildContentFromEdit({
        displayName: input.displayName,
        connectorKind,
        launch: input.launch,
        credentialRefs: input.credentialRefs ?? [],
        provenance: input.provenance ?? previousProvenance ?? { source: "manual" },
        ...(input.trust !== undefined
          ? { trust: input.trust }
          : Option.isSome(currentRevision) && currentRevision.value.trust !== undefined
            ? { trust: currentRevision.value.trust }
            : {}),
      });
      const revisionId = computeAgentProfileRevisionId(content);
      const revision: AgentProfileRevision = {
        revisionId,
        displayName: input.displayName,
        connectorKind,
        launch: input.launch,
        credentialRefs: input.credentialRefs ?? [],
        provenance: content.provenance,
        ...(input.trust !== undefined
          ? { trust: input.trust }
          : Option.isSome(currentRevision) && currentRevision.value.trust !== undefined
            ? { trust: currentRevision.value.trust }
            : {}),
        parentRevisionId: profile.currentRevisionId,
        createdAt: now,
      };
      const { revisionReused } = yield* repository.repointProfileRevision({
        profileId: profile.profileId,
        currentRevisionId: revisionId,
        updatedAt: now,
        revision,
        contentHash: computeAgentProfileContentHash(content),
      });
      const updatedProfile: AgentProfile = {
        ...profile,
        currentRevisionId: revisionId,
        updatedAt: now,
      };
      return { profile: updatedProfile, revision, reused: revisionReused };
    }).pipe(Effect.mapError(toServiceError("updateProfile")));

  const tombstoneProfile: AgentProfileServiceShape["tombstoneProfile"] = (profileId) =>
    Effect.gen(function* () {
      const existing = yield* repository.getProfile(profileId);
      if (Option.isNone(existing)) {
        return yield* profileNotFoundError(profileId);
      }
      if (existing.value.status === "retired") {
        return existing.value;
      }
      const updated = yield* repository.tombstoneProfile(profileId, new Date().toISOString());
      if (Option.isNone(updated)) {
        return yield* profileNotFoundError(profileId);
      }
      return updated.value;
    }).pipe(Effect.mapError(toServiceError("tombstoneProfile")));

  return {
    listProfiles,
    getProfile,
    createProfile,
    updateProfile,
    tombstoneProfile,
    resolveSessionLaunch,
    ensureLegacyAcpProfile,
  } satisfies AgentProfileServiceShape;
});

export const AgentProfileServiceLive = Layer.effect(AgentProfileService, makeAgentProfileService);

function toServiceError(operation: string) {
  return (cause: unknown): ExternalAgentProfileError =>
    cause instanceof ExternalAgentProfileError
      ? cause
      : new ExternalAgentProfileError({
          code: "internal",
          message: `External agent profile service failed during ${operation}.`,
          status: 500,
          cause,
        });
}
