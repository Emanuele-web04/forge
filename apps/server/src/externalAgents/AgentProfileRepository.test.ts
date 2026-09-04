import { assert, it } from "@effect/vitest";
import { AgentProfileId } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe } from "vitest";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { AgentProfileRepository, AgentProfileRepositoryLive } from "./AgentProfileRepository.ts";
import {
  computeAgentProfileContentHash,
  computeAgentProfileRevisionId,
  type AgentProfileRevisionContent,
} from "./agentProfileIdentity.ts";

const layer = it.layer(
  AgentProfileRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const content: AgentProfileRevisionContent = {
  displayName: "Cline",
  connectorKind: "acp",
  launch: { kind: "command", command: "cline", args: [] },
  credentialRefs: [],
  provenance: { source: "manual" },
};

function revision(
  suffix: string,
  parentRevisionId?: ReturnType<typeof computeAgentProfileRevisionId>,
  createdAt = "2026-08-01T00:00:00.000Z",
) {
  const nextContent: AgentProfileRevisionContent = {
    ...content,
    displayName: `Cline ${suffix}`,
  };
  return {
    content: nextContent,
    revision: {
      revisionId: computeAgentProfileRevisionId(nextContent),
      displayName: nextContent.displayName,
      connectorKind: nextContent.connectorKind,
      launch: nextContent.launch,
      credentialRefs: nextContent.credentialRefs,
      provenance: nextContent.provenance,
      ...(parentRevisionId !== undefined ? { parentRevisionId } : {}),
      createdAt,
    },
    contentHash: computeAgentProfileContentHash(nextContent),
  };
}

layer("AgentProfileRepository", (it) => {
  it.effect("creates a profile with an immutable content-addressed revision", () =>
    Effect.gen(function* () {
      const repository = yield* AgentProfileRepository;
      const created = revision("v1");
      const { revisionReused } = yield* repository.createProfile({
        profile: {
          profileId: AgentProfileId.makeUnsafe("agentprofile_one"),
          name: "One",
          currentRevisionId: created.revision.revisionId,
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        revision: created.revision,
        contentHash: created.contentHash,
      });
      assert.isFalse(revisionReused);

      const stored = Option.getOrUndefined(yield* repository.getProfile("agentprofile_one"));
      assert.isDefined(stored);
      assert.strictEqual(stored?.currentRevisionId, created.revision.revisionId);
      assert.strictEqual(stored?.status, "active");

      const storedRevision = Option.getOrUndefined(
        yield* repository.getRevision(created.revision.revisionId),
      );
      assert.isDefined(storedRevision);
      assert.strictEqual(storedRevision?.displayName, "Cline v1");
    }),
  );

  it.effect("dedupes identical normalized revisions by content hash", () =>
    Effect.gen(function* () {
      const repository = yield* AgentProfileRepository;
      const created = revision("same");
      yield* repository.createProfile({
        profile: {
          profileId: AgentProfileId.makeUnsafe("agentprofile_a"),
          name: "A",
          currentRevisionId: created.revision.revisionId,
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        revision: created.revision,
        contentHash: created.contentHash,
      });
      const second = revision("same");
      const { revisionReused } = yield* repository.createProfile({
        profile: {
          profileId: AgentProfileId.makeUnsafe("agentprofile_b"),
          name: "B",
          currentRevisionId: second.revision.revisionId,
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        revision: second.revision,
        contentHash: second.contentHash,
      });
      assert.isTrue(revisionReused);
    }),
  );

  it.effect("edits insert a new revision without mutating the previous one", () =>
    Effect.gen(function* () {
      const repository = yield* AgentProfileRepository;
      const v1 = revision("v1");
      yield* repository.createProfile({
        profile: {
          profileId: AgentProfileId.makeUnsafe("agentprofile_edit"),
          name: "Edit",
          currentRevisionId: v1.revision.revisionId,
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        revision: v1.revision,
        contentHash: v1.contentHash,
      });
      const v2 = revision("v2", v1.revision.revisionId);
      yield* repository.repointProfileRevision({
        profileId: "agentprofile_edit",
        currentRevisionId: v2.revision.revisionId,
        updatedAt: "2026-08-02T00:00:00.000Z",
        revision: v2.revision,
        contentHash: v2.contentHash,
      });

      const profile = Option.getOrUndefined(yield* repository.getProfile("agentprofile_edit"));
      assert.strictEqual(profile?.currentRevisionId, v2.revision.revisionId);

      // The historical revision is still resolvable by its own id.
      const historical = Option.getOrUndefined(
        yield* repository.getRevision(v1.revision.revisionId),
      );
      assert.isDefined(historical);
      assert.strictEqual(historical?.displayName, "Cline v1");

      const history = yield* repository.getProfileRevisions("agentprofile_edit");
      assert.strictEqual(history.length, 2);
      assert.strictEqual(history[0]?.revisionId, v2.revision.revisionId);
      assert.strictEqual(history[1]?.revisionId, v1.revision.revisionId);
    }),
  );

  it.effect("tombstones a profile instead of deleting it", () =>
    Effect.gen(function* () {
      const repository = yield* AgentProfileRepository;
      const created = revision("v1");
      yield* repository.createProfile({
        profile: {
          profileId: AgentProfileId.makeUnsafe("agentprofile_remove"),
          name: "Remove",
          currentRevisionId: created.revision.revisionId,
          status: "active",
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-01T00:00:00.000Z",
        },
        revision: created.revision,
        contentHash: created.contentHash,
      });

      const tombstoned = Option.getOrUndefined(
        yield* repository.tombstoneProfile("agentprofile_remove", "2026-08-03T00:00:00.000Z"),
      );
      assert.strictEqual(tombstoned?.status, "retired");
      assert.strictEqual(tombstoned?.lifecycleEvent?.kind, "retire");

      // The profile row and its revisions survive for historical reads.
      const stored = Option.getOrUndefined(yield* repository.getProfile("agentprofile_remove"));
      assert.isDefined(stored);
      assert.strictEqual(stored?.status, "retired");
      assert.strictEqual(stored?.lifecycleEvent?.kind, "retire");
      const historical = Option.getOrUndefined(
        yield* repository.getRevision(created.revision.revisionId),
      );
      assert.isDefined(historical);
    }),
  );
});
