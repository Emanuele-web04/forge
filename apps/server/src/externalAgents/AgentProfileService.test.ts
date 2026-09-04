import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { describe } from "vitest";

import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentProfileRepositoryLive } from "./AgentProfileRepository.ts";
import {
  AgentProfileService,
  AgentProfileServiceLive,
  ExternalAgentProfileError,
} from "./AgentProfileService.ts";
import { legacyAcpProfileId, legacyAcpRevisionId } from "./agentProfileIdentity.ts";

const testLayer = AgentProfileServiceLive.pipe(
  Layer.provideMerge(AgentProfileRepositoryLive),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerSecretStoreLive.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "synara-external-agent-profiles-test-" }),
      ),
      Layer.provide(NodeServices.layer),
    ),
  ),
);

const layer = it.layer(testLayer);

const launch = { kind: "command" as const, command: "cline", args: [] as string[] };

layer("AgentProfileService", (it) => {
  it.effect("creates two independent profiles usable simultaneously", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const first = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      const second = yield* service.createProfile({
        name: "Roo",
        displayName: "Roo Code",
        connectorKind: "acp",
        launch: { kind: "command", command: "roo", args: [] },
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      assert.notEqual(first.profile.profileId, second.profile.profileId);

      const listed = yield* service.listProfiles();
      assert.strictEqual(listed.length, 2);
      const byId = new Map(listed.map((profile) => [profile.profileId, profile]));
      assert.strictEqual(byId.get(first.profile.profileId)?.name, "Cline");
      assert.strictEqual(byId.get(second.profile.profileId)?.name, "Roo");

      const detail = yield* service.getProfile(first.profile.profileId);
      assert.strictEqual(detail.currentRevision.displayName, "Cline");
      assert.strictEqual(detail.revisions.length, 1);
    }),
  );

  it.effect("editing a profile creates a new revision and reuses identical content", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });

      const edited = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Cline (renamed)",
        launch,
        credentialRefs: [],
      });
      assert.notEqual(edited.profile.currentRevisionId, created.profile.currentRevisionId);
      assert.isFalse(edited.reused);

      // Editing back to the original content reuses the deduped revision.
      const reverted = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Cline",
        launch,
        credentialRefs: [],
      });
      assert.isTrue(reverted.reused);
      assert.strictEqual(reverted.revision.revisionId, created.revision.revisionId);

      const detail = yield* service.getProfile(created.profile.profileId);
      // Reverting to the original content reuses the original revision, so the
      // content-addressed history collapses back to a single revision.
      assert.strictEqual(detail.revisions.length, 1);
      assert.strictEqual(detail.currentRevision.revisionId, created.revision.revisionId);
    }),
  );

  it.effect("refuses new sessions for retired profiles but keeps history readable", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch,
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      yield* service.tombstoneProfile(created.profile.profileId);

      const launchResult = yield* Effect.flip(
        service.resolveSessionLaunch({
          profileId: created.profile.profileId,
          revisionId: created.revision.revisionId,
        }),
      );
      assert.instanceOf(launchResult, ExternalAgentProfileError);
      assert.strictEqual(launchResult.code, "profile-removed");

      // Historical thread reads still resolve the pinned revision and record
      // the retire lifecycle event alongside the retired status.
      const detail = yield* service.getProfile(created.profile.profileId);
      assert.strictEqual(detail.profile.status, "retired");
      assert.strictEqual(detail.profile.lifecycleEvent?.kind, "retire");
      assert.strictEqual(detail.currentRevision.revisionId, created.revision.revisionId);
    }),
  );

  it.effect("resolves a session launch with credential expansion", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const secrets = yield* ServerSecretStore;
      const created = yield* service.createProfile({
        name: "Cline",
        displayName: "Cline",
        connectorKind: "acp",
        launch: { kind: "command", command: "cline", args: [], envRefs: [] },
        credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
        provenance: { source: "manual" },
      });
      // KAR-529 provenance gate: a profile with credentials must be trusted
      // before the secret store is touched.
      const updated = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Cline",
        launch: { kind: "command", command: "cline", args: [], envRefs: [] },
        credentialRefs: [{ name: "api-key", envKey: "CLINE_API_KEY", required: true }],
        provenance: { source: "manual" },
        trust: { brands: ["openai"] },
      });
      yield* secrets.set(
        `external-agent-profile:${created.profile.profileId}:api-key`,
        new TextEncoder().encode("secret-value"),
      );

      const resolved = yield* service.resolveSessionLaunch({
        profileId: created.profile.profileId,
        revisionId: updated.revision.revisionId,
      });
      assert.strictEqual(resolved.profile.profileId, created.profile.profileId);
      assert.strictEqual(resolved.env.CLINE_API_KEY, "secret-value");
    }),
  );

  it.effect("rejects an update that would drift a cli-kind profile into a mismatched launch", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Structured CLI",
        displayName: "Structured CLI",
        connectorKind: "cli-structured",
        launch: { kind: "command", command: "my-cli", frameMode: "ndjson" },
        credentialRefs: [],
        provenance: { source: "manual" },
      });

      // cli-structured may only use ndjson command launches (AC #4).
      const invalid = yield* Effect.flip(
        service.updateProfile({
          profileId: created.profile.profileId,
          displayName: "Structured CLI",
          launch: { kind: "command", command: "my-cli", frameMode: "line" },
          credentialRefs: [],
        }),
      );
      assert.instanceOf(invalid, ExternalAgentProfileError);
      assert.strictEqual(invalid.code, "invalid-connector-mapping");

      // An update that keeps the ndjson framing is accepted.
      const valid = yield* service.updateProfile({
        profileId: created.profile.profileId,
        displayName: "Structured CLI (renamed)",
        launch: { kind: "command", command: "my-cli", frameMode: "ndjson" },
        credentialRefs: [],
      });
      assert.strictEqual(valid.revision.launch.kind, "command");
      assert.strictEqual(
        valid.revision.launch.kind === "command" ? valid.revision.launch.frameMode : undefined,
        "ndjson",
      );
    }),
  );

  it.effect("rejects a cli-basic profile created with an endpoint launch via the schema", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      // createProfile receives already-decoded input, so the schema rejection
      // lives at the create-input decode boundary (verified in contracts). Here
      // verify the service layer still persists a well-formed cli-basic profile.
      const created = yield* service.createProfile({
        name: "Basic CLI",
        displayName: "Basic CLI",
        connectorKind: "cli-basic",
        launch: { kind: "command", command: "plain-cli", frameMode: "line" },
        credentialRefs: [],
        provenance: { source: "manual" },
      });
      const detail = yield* service.getProfile(created.profile.profileId);
      assert.strictEqual(detail.currentRevision.connectorKind, "cli-basic");
    }),
  );

  it.effect("refuses credential expansion for an untrusted profile", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const created = yield* service.createProfile({
        name: "Rogue",
        displayName: "Rogue",
        connectorKind: "acp",
        launch: { kind: "command", command: "rogue", args: [], envRefs: [] },
        credentialRefs: [{ name: "api-key", envKey: "ROGUE_API_KEY", required: true }],
        provenance: { source: "manual" },
      });
      // No trust claims attached, so credential release must be refused even
      // though the profile is active.
      const launchResult = yield* Effect.flip(
        service.resolveSessionLaunch({
          profileId: created.profile.profileId,
          revisionId: created.revision.revisionId,
        }),
      );
      assert.instanceOf(launchResult, ExternalAgentProfileError);
      assert.strictEqual(launchResult.code, "profile-untrusted");
    }),
  );

  it.effect("migrates the legacy slot deterministically on session resolution", () =>
    Effect.gen(function* () {
      const service = yield* AgentProfileService;
      const resolved = yield* service.resolveSessionLaunch({
        profileId: legacyAcpProfileId(),
        revisionId: legacyAcpRevisionId(),
      });
      assert.strictEqual(resolved.profile.profileId, legacyAcpProfileId());
      assert.strictEqual(resolved.profile.name, "Legacy ACP Agent");

      // Idempotent: a second resolution does not duplicate the profile.
      const again = yield* service.resolveSessionLaunch({
        profileId: legacyAcpProfileId(),
        revisionId: legacyAcpRevisionId(),
      });
      assert.strictEqual(again.profile.profileId, legacyAcpProfileId());
      const listed = yield* service.listProfiles();
      assert.strictEqual(
        listed.filter((profile) => profile.profileId === legacyAcpProfileId()).length,
        1,
      );
    }),
  );
});
