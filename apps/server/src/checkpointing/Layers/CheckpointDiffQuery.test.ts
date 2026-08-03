import { CheckpointRef, ProjectId, ThreadId, TurnId, type ProjectKind } from "@synara/contracts";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectionSnapshotQuery,
  type ProjectionFullThreadDiffContext,
  type ProjectionThreadCheckpointContext,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { fakeProjectionSnapshotQuery } from "../../orchestration/testing/fakeProjectionSnapshotQuery.ts";
import { checkpointRefForThreadTurn, checkpointRefForThreadTurnStart } from "../Utils.ts";
import { CheckpointDiffQueryLive } from "./CheckpointDiffQuery.ts";
import { CheckpointStore, type CheckpointStoreShape } from "../Services/CheckpointStore.ts";
import { CheckpointDiffQuery } from "../Services/CheckpointDiffQuery.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly projectKind?: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode?: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status?: "ready" | "missing" | "error";
}): ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    projectKind: input.projectKind ?? "project",
    workspaceRoot: input.workspaceRoot,
    envMode: input.envMode ?? "local",
    worktreePath: input.worktreePath,
    workingDirectory: null,
    checkpoints: [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: input.status ?? "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

function makeFullThreadDiffContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly projectKind?: ProjectKind;
  readonly workspaceRoot: string;
  readonly envMode?: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly latestCheckpointTurnCount: number;
  readonly baselineCheckpointRef?: CheckpointRef | null;
  readonly toCheckpointRef: CheckpointRef | null;
}): ProjectionFullThreadDiffContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    projectKind: input.projectKind ?? "project",
    workspaceRoot: input.workspaceRoot,
    envMode: input.envMode ?? "local",
    worktreePath: input.worktreePath,
    workingDirectory: null,
    latestCheckpointTurnCount: input.latestCheckpointTurnCount,
    baselineCheckpointRef: input.baselineCheckpointRef ?? input.toCheckpointRef,
    toCheckpointRef: input.toCheckpointRef,
  };
}

describe("CheckpointDiffQueryLive", () => {
  it("prefers exact turn-start checkpoints for single-turn diffs", async () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const threadId = ThreadId.makeUnsafe("thread-1");
    const toCheckpointRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );
    const hasCheckpointRefCalls: Array<CheckpointRef> = [];
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: ({ checkpointRef }) =>
        Effect.sync(() => {
          hasCheckpointRefCalls.push(checkpointRef);
          return true;
        }),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    const expectedFromRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurnStart(threadId, TurnId.makeUnsafe("turn-1")).replace(
        "refs/synara/",
        "refs/historical/",
      ),
    );
    expect(hasCheckpointRefCalls).toEqual([expectedFromRef]);
    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: expectedFromRef,
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 1,
      diff: "diff patch",
    });
  });

  it("uses the narrow full-thread diff context without loading checkpoint summaries", async () => {
    const projectId = ProjectId.makeUnsafe("project-full-diff");
    const threadId = ThreadId.makeUnsafe("thread-full-diff");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 2);
    const historicalBaselineRef = CheckpointRef.makeUnsafe(
      checkpointRefForThreadTurn(threadId, 1).replace("refs/synara/", "refs/historical/"),
    );
    const diffCheckpointsCalls: Array<{
      readonly fromCheckpointRef: CheckpointRef;
      readonly toCheckpointRef: CheckpointRef;
      readonly cwd: string;
      readonly ignoreWhitespace: boolean;
    }> = [];

    const fullThreadDiffContext = makeFullThreadDiffContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      worktreePath: null,
      latestCheckpointTurnCount: 2,
      baselineCheckpointRef: historicalBaselineRef,
      toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.die("unused"),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace });
          return "full diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getFullThreadDiffContext: () => Effect.succeed(Option.some(fullThreadDiffContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 2,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([
      {
        cwd: "/tmp/workspace",
        fromCheckpointRef: CheckpointRef.makeUnsafe(
          historicalBaselineRef.replace(/\/turn\/1$/, "/turn/0"),
        ),
        toCheckpointRef,
        ignoreWhitespace: true,
      },
    ]);
    expect(result).toEqual({
      threadId,
      fromTurnCount: 0,
      toTurnCount: 2,
      diff: "full diff patch",
    });
  });

  it("fails when the thread is missing from the snapshot", async () => {
    const threadId = ThreadId.makeUnsafe("thread-missing");

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed(""),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Thread 'thread-missing' not found.");
  });

  it("fails when a worktree-mode thread has no materialized worktree path", async () => {
    const projectId = ProjectId.makeUnsafe("project-worktree");
    const threadId = ThreadId.makeUnsafe("thread-worktree");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/project-root",
      envMode: "worktree",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Workspace path missing");
  });

  it("fails for a chat-kind project with no materialized worktree, since chat containers have no real cwd", async () => {
    const projectId = ProjectId.makeUnsafe("project-chat");
    const threadId = ThreadId.makeUnsafe("thread-chat");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      projectKind: "chat",
      workspaceRoot: "/tmp/chat-root",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Workspace path missing");
  });

  it("uses the workspace root as a real cwd for a studio-kind project", async () => {
    const projectId = ProjectId.makeUnsafe("project-studio");
    const threadId = ThreadId.makeUnsafe("thread-studio");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
    const diffCheckpointsCalls: Array<{ readonly cwd: string }> = [];

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      projectKind: "studio",
      workspaceRoot: "/tmp/studio-root",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: ({ cwd }) =>
        Effect.sync(() => {
          diffCheckpointsCalls.push({ cwd });
          return "diff patch";
        }),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(diffCheckpointsCalls).toEqual([{ cwd: "/tmp/studio-root" }]);
    expect(result.diff).toBe("diff patch");
  });

  it("fails cleanly when the selected checkpoint is still missing", async () => {
    const projectId = ProjectId.makeUnsafe("project-missing");
    const threadId = ThreadId.makeUnsafe("thread-missing-checkpoint");
    const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);

    const threadCheckpointContext = makeThreadCheckpointContext({
      projectId,
      threadId,
      workspaceRoot: "/tmp/workspace",
      envMode: "local",
      worktreePath: null,
      checkpointTurnCount: 1,
      checkpointRef: toCheckpointRef,
      status: "missing",
    });

    const checkpointStore: CheckpointStoreShape = {
      isGitRepository: () => Effect.succeed(true),
      captureCheckpoint: () => Effect.void,
      copyCheckpointRef: () => Effect.succeed(true),
      hasCheckpointRef: () => Effect.succeed(true),
      restoreCheckpoint: () => Effect.succeed(true),
      reverseCheckpointDiff: () => Effect.succeed(true),
      diffCheckpoints: () => Effect.succeed("diff patch"),
      deleteCheckpointRefs: () => Effect.void,
    };

    const layer = CheckpointDiffQueryLive.pipe(
      Layer.provideMerge(Layer.succeed(CheckpointStore, checkpointStore)),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          fakeProjectionSnapshotQuery({
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
          }),
        ),
      ),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const query = yield* CheckpointDiffQuery;
          return yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 0,
            toTurnCount: 1,
          });
        }).pipe(Effect.provide(layer)),
      ),
    ).rejects.toThrow("Checkpoint diff is not available yet for turn 1.");
  });
});
