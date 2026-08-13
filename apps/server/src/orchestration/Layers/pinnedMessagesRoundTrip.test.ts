import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  ThreadMarkerId,
} from "@synara/contracts";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { describe, expect, it } from "vitest";

import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

async function createSystem(dbPath?: string) {
  const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "synara-pinned-roundtrip-test-",
  });
  const layer = OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provideMerge(dbPath ? makeSqlitePersistenceLive(dbPath) : SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(layer);
  const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
  const query = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
  return {
    engine,
    query,
    run: <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect),
    dispose: () => runtime.dispose(),
  };
}

describe("thread annotations round-trip", () => {
  it("persists a thread goal into detail, full snapshots, and shell snapshots", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "synara-goal-roundtrip-"));
    const dbPath = path.join(stateDir, "state.sqlite");
    let system = await createSystem(dbPath);
    const createdAt = "2026-06-06T00:00:00.000Z";
    const projectId = ProjectId.makeUnsafe("project-goal");
    const threadId = ThreadId.makeUnsafe("thread-goal");

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-goal"),
          projectId,
          title: "Goal project",
          workspaceRoot: "/tmp/project-goal",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-goal"),
          threadId,
          projectId,
          title: "Goal thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-goal-set"),
          threadId,
          goal: "Ship the complete thread-goal feature",
        }),
      );

      const detail = Option.getOrNull(await system.run(system.query.getThreadDetailById(threadId)));
      const snapshot = await system.run(system.query.getSnapshot());
      const shellSnapshot = await system.run(system.query.getShellSnapshot());

      expect(detail?.goal).toBe("Ship the complete thread-goal feature");
      expect(snapshot.threads.find((thread) => thread.id === threadId)?.goal).toBe(detail?.goal);
      expect(shellSnapshot.threads.find((thread) => thread.id === threadId)?.goal).toBe(
        detail?.goal,
      );
      expect(shellSnapshot.threads.find((thread) => thread.id === threadId)?.goalStartedAt).toBe(
        detail?.goalStartedAt,
      );
      expect(
        shellSnapshot.threads.find((thread) => thread.id === threadId)?.goalPausedAt,
      ).toBeNull();

      await system.dispose();
      system = await createSystem(dbPath);
      const restartedDetail = Option.getOrNull(
        await system.run(system.query.getThreadDetailById(threadId)),
      );
      expect(restartedDetail?.goal).toBe("Ship the complete thread-goal feature");

      await system.run(
        system.engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.makeUnsafe("cmd-goal-clear"),
          threadId,
          goal: "",
        }),
      );
      const clearedDetail = Option.getOrNull(
        await system.run(system.query.getThreadDetailById(threadId)),
      );
      expect(clearedDetail?.goal).toBe("");
    } finally {
      await system.dispose();
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("persists pinned-message commands into projected thread detail and snapshots", async () => {
    const system = await createSystem();
    const createdAt = "2026-06-06T00:00:00.000Z";
    const projectId = ProjectId.makeUnsafe("project-pins");
    const threadId = ThreadId.makeUnsafe("thread-pins");
    const messageId = MessageId.makeUnsafe("assistant-msg-1");
    const secondMessageId = MessageId.makeUnsafe("assistant-msg-2");

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-pins"),
          projectId,
          title: "Pins project",
          workspaceRoot: "/tmp/project-pins",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-pins"),
          threadId,
          projectId,
          title: "Pins thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );

      await system.run(
        system.engine.dispatch({
          type: "thread.pinned-message.add",
          commandId: CommandId.makeUnsafe("cmd-pin-add"),
          threadId,
          messageId,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.pinned-message.add",
          commandId: CommandId.makeUnsafe("cmd-pin-add-second"),
          threadId,
          messageId: secondMessageId,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.pinned-message.done.set",
          commandId: CommandId.makeUnsafe("cmd-pin-done"),
          threadId,
          messageId,
          done: true,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.pinned-message.label.set",
          commandId: CommandId.makeUnsafe("cmd-pin-label"),
          threadId,
          messageId,
          label: "Review this answer",
        }),
      );

      const detail = await system.run(system.query.getThreadDetailById(threadId));
      const thread = Option.getOrNull(detail);
      expect(thread).not.toBeNull();
      expect(thread?.pinnedMessages).toHaveLength(2);
      expect(thread?.pinnedMessages?.[0]).toMatchObject({
        messageId,
        label: "Review this answer",
        done: true,
      });
      expect(thread?.pinnedMessages?.[0]?.pinnedAt).toEqual(expect.any(String));
      expect(thread?.pinnedMessages?.[1]).toMatchObject({
        messageId: secondMessageId,
        label: null,
        done: false,
      });

      // And via the full snapshot, which is what the client hydrates from on (re)connect.
      const snapshot = await system.run(system.query.getSnapshot());
      const snapshotThread = snapshot.threads.find((candidate) => candidate.id === threadId);
      expect(snapshotThread?.pinnedMessages).toEqual(thread?.pinnedMessages);

      // Shell snapshots feed the sidebar and intentionally avoid the sidepanel payload columns.
      const shellSnapshot = await system.run(system.query.getShellSnapshot());
      const shellThread = shellSnapshot.threads.find((candidate) => candidate.id === threadId);
      expect(shellThread).not.toBeUndefined();
      expect("pinnedMessages" in (shellThread ?? {})).toBe(false);
      expect("notes" in (shellThread ?? {})).toBe(false);
    } finally {
      await system.dispose();
    }
  });

  it("persists thread marker commands into projected thread detail and snapshots", async () => {
    const system = await createSystem();
    const createdAt = "2026-06-06T00:00:00.000Z";
    const projectId = ProjectId.makeUnsafe("project-markers");
    const threadId = ThreadId.makeUnsafe("thread-markers");
    const messageId = MessageId.makeUnsafe("assistant-marker-msg-1");
    const firstMarkerId = ThreadMarkerId.makeUnsafe("marker-1");
    const secondMarkerId = ThreadMarkerId.makeUnsafe("marker-2");

    try {
      await system.run(
        system.engine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe("cmd-project-markers"),
          projectId,
          title: "Markers project",
          workspaceRoot: "/tmp/project-markers",
          defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
          createdAt,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe("cmd-thread-markers"),
          threadId,
          projectId,
          title: "Markers thread",
          modelSelection: { provider: "codex", model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt,
        }),
      );

      await system.run(
        system.engine.dispatch({
          type: "thread.marker.add",
          commandId: CommandId.makeUnsafe("cmd-marker-add"),
          threadId,
          markerId: firstMarkerId,
          messageId,
          startOffset: 6,
          endOffset: 20,
          selectedText: "important text",
          style: "highlight",
          color: "yellow",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.marker.add",
          commandId: CommandId.makeUnsafe("cmd-marker-add-second"),
          threadId,
          markerId: secondMarkerId,
          messageId,
          startOffset: 30,
          endOffset: 39,
          selectedText: "underline",
          style: "underline",
          color: "blue",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.marker.done.set",
          commandId: CommandId.makeUnsafe("cmd-marker-done"),
          threadId,
          markerId: firstMarkerId,
          done: true,
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.marker.label.set",
          commandId: CommandId.makeUnsafe("cmd-marker-label"),
          threadId,
          markerId: firstMarkerId,
          label: "Research later",
        }),
      );
      await system.run(
        system.engine.dispatch({
          type: "thread.marker.remove",
          commandId: CommandId.makeUnsafe("cmd-marker-remove"),
          threadId,
          markerId: secondMarkerId,
        }),
      );

      const detail = await system.run(system.query.getThreadDetailById(threadId));
      const thread = Option.getOrNull(detail);
      expect(thread).not.toBeNull();
      expect(thread?.threadMarkers).toHaveLength(1);
      expect(thread?.threadMarkers?.[0]).toMatchObject({
        id: firstMarkerId,
        messageId,
        startOffset: 6,
        endOffset: 20,
        selectedText: "important text",
        style: "highlight",
        color: "yellow",
        label: "Research later",
        done: true,
      });
      expect(thread?.threadMarkers?.[0]?.createdAt).toEqual(expect.any(String));
      expect(thread?.threadMarkers?.[0]?.updatedAt).toEqual(expect.any(String));

      const snapshot = await system.run(system.query.getSnapshot());
      const snapshotThread = snapshot.threads.find((candidate) => candidate.id === threadId);
      expect(snapshotThread?.threadMarkers).toEqual(thread?.threadMarkers);

      const shellSnapshot = await system.run(system.query.getShellSnapshot());
      const shellThread = shellSnapshot.threads.find((candidate) => candidate.id === threadId);
      expect(shellThread).not.toBeUndefined();
      expect("threadMarkers" in (shellThread ?? {})).toBe(false);
    } finally {
      await system.dispose();
    }
  });
});
