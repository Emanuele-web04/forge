// FILE: threadRetention.test.ts
// Purpose: Verifies inactive-thread selection without running the server loop.
// Layer: Server maintenance tests
// Exports: Vitest coverage for threadRetention helpers.

import {
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
} from "@synara/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import type { AutomationRepositoryShape } from "./persistence/Services/AutomationRepository";
import { ServerLifecycleEvents, ServerLifecycleEventsLive } from "./serverLifecycleEvents";
import {
  getRetentionArchiveRootIds,
  runThreadRetentionSweep,
  THREAD_RETENTION_COMMAND_ID_PREFIX,
  THREAD_RETENTION_UNUSED_MS,
} from "./threadRetention";

function makeReadModelThread(
  overrides: Partial<OrchestrationReadModel["threads"][number]> = {},
): OrchestrationReadModel["threads"][number] {
  return {
    id: ThreadId.makeUnsafe("thread-active"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    latestUserMessageAt: null,
    deletedAt: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: null,
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    ...overrides,
  } as OrchestrationReadModel["threads"][number];
}

function makeReadModel(threads: OrchestrationReadModel["threads"]): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    threads,
    updatedAt: "2026-04-20T00:00:00.000Z",
  };
}

describe("thread retention", () => {
  it("selects inactive threads older than the seven-day hide window", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const staleThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-stale"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
    });
    const recentThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-recent"),
      latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS + 1).toISOString(),
    });

    expect(getRetentionArchiveRootIds(makeReadModel([staleThread, recentThread]), nowMs)).toEqual([
      staleThread.id,
    ]);
  });

  it("does not select busy or pending threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-running"),
            latestUserMessageAt: oldActivityAt,
            session: {
              threadId: ThreadId.makeUnsafe("thread-running"),
              status: "running",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: oldActivityAt,
            },
          }),
          makeReadModelThread({
            id: ThreadId.makeUnsafe("thread-pending"),
            latestUserMessageAt: oldActivityAt,
            hasPendingUserInput: true,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });

  it("does not select pinned threads even when they are old", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const pinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-pinned"),
      isPinned: true,
      latestUserMessageAt: oldActivityAt,
    });
    const unpinnedThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-unpinned"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getRetentionArchiveRootIds(makeReadModel([pinnedThread, unpinnedThread]), nowMs),
    ).toEqual([unpinnedThread.id]);
  });

  it("does not select enabled heartbeat automation target threads", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const heartbeatTarget = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-heartbeat-target"),
      latestUserMessageAt: oldActivityAt,
    });
    const ordinaryThread = makeReadModelThread({
      id: ThreadId.makeUnsafe("thread-ordinary"),
      latestUserMessageAt: oldActivityAt,
    });

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([heartbeatTarget, ordinaryThread]),
        nowMs,
        new Set([heartbeatTarget.id]),
      ),
    ).toEqual([ordinaryThread.id]);
  });

  it("selects one archive root for a fully inactive subagent tree", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const childId = ThreadId.makeUnsafe("thread-child");
    const grandchildId = ThreadId.makeUnsafe("thread-grandchild");

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([
          makeReadModelThread({ id: parentId, latestUserMessageAt: oldActivityAt }),
          makeReadModelThread({
            id: childId,
            parentThreadId: parentId,
            latestUserMessageAt: oldActivityAt,
          }),
          makeReadModelThread({
            id: grandchildId,
            parentThreadId: childId,
            latestUserMessageAt: oldActivityAt,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([parentId]);
  });

  it("treats an inactive thread whose parent is absent as an archive root", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const oldActivityAt = new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString();
    const missingParentId = ThreadId.makeUnsafe("thread-missing-parent");
    const orphanId = ThreadId.makeUnsafe("thread-orphan");
    const childId = ThreadId.makeUnsafe("thread-orphan-child");

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([
          makeReadModelThread({
            id: orphanId,
            parentThreadId: missingParentId,
            latestUserMessageAt: oldActivityAt,
          }),
          makeReadModelThread({
            id: childId,
            parentThreadId: orphanId,
            latestUserMessageAt: oldActivityAt,
          }),
        ]),
        nowMs,
      ),
    ).toEqual([orphanId]);
  });

  it("does not archive a stale parent over a recent child", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const childId = ThreadId.makeUnsafe("thread-child");

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([
          makeReadModelThread({
            id: parentId,
            latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
          }),
          makeReadModelThread({
            id: childId,
            parentThreadId: parentId,
            latestUserMessageAt: new Date(nowMs - 1).toISOString(),
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });

  it("keeps a stale child with its recent parent because children are not standalone chats", () => {
    const nowMs = Date.parse("2026-04-20T00:00:00.000Z");
    const parentId = ThreadId.makeUnsafe("thread-parent");
    const childId = ThreadId.makeUnsafe("thread-child");

    expect(
      getRetentionArchiveRootIds(
        makeReadModel([
          makeReadModelThread({
            id: parentId,
            latestUserMessageAt: new Date(nowMs - 1).toISOString(),
          }),
          makeReadModelThread({
            id: childId,
            parentThreadId: parentId,
            latestUserMessageAt: new Date(nowMs - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
          }),
        ]),
        nowMs,
      ),
    ).toEqual([]);
  });

  it("dispatches reversible archive commands and publishes completed progress", async () => {
    const archivedThreadId = ThreadId.makeUnsafe("thread-to-archive");
    const dispatchedCommands: OrchestrationCommand[] = [];
    let pruneCount = 0;
    const shellSnapshot = makeReadModel([
      makeReadModelThread({
        id: archivedThreadId,
        latestUserMessageAt: new Date(Date.now() - THREAD_RETENTION_UNUSED_MS - 1).toISOString(),
      }),
    ]) as unknown as OrchestrationShellSnapshot;
    const engine = {
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatchedCommands.push(command);
          return { sequence: 1 };
        }),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () => Effect.succeed(shellSnapshot),
    } as unknown as ProjectionSnapshotQueryShape;
    const automationRepository = {
      list: () => Effect.succeed({ definitions: [], runs: [], memories: [] }),
    } as unknown as AutomationRepositoryShape;

    const maintenanceEvent = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runThreadRetentionSweep(
          engine,
          snapshotQuery,
          automationRepository,
          Effect.sync(() => {
            pruneCount += 1;
          }),
        );
        const lifecycle = yield* ServerLifecycleEvents;
        return (yield* lifecycle.snapshot).events.find((event) => event.type === "maintenance");
      }).pipe(Effect.provide(ServerLifecycleEventsLive)),
    );

    expect(dispatchedCommands).toHaveLength(1);
    expect(dispatchedCommands[0]).toMatchObject({
      type: "thread.archive",
      threadId: archivedThreadId,
    });
    expect(dispatchedCommands[0]?.commandId).toMatch(
      new RegExp(`^${THREAD_RETENTION_COMMAND_ID_PREFIX}`),
    );
    expect(pruneCount).toBe(1);
    expect(maintenanceEvent).toMatchObject({
      type: "maintenance",
      payload: {
        task: "thread-retention",
        state: "completed",
        deletedCount: 1,
        totalCount: 1,
      },
    });
  });
});
