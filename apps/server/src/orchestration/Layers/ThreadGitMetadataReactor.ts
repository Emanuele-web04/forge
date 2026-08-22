import { CommandId, type ProviderRuntimeEvent, type ThreadId } from "@synara/contracts";
import { makeDrainableWorker, startDrainableWorkerProducers } from "@synara/shared/DrainableWorker";
import { Cause, Effect, Layer, Option, Stream } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitManager } from "../../git/Services/GitManager.ts";
import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ThreadGitMetadataReactor,
  type ThreadGitMetadataReactorShape,
} from "../Services/ThreadGitMetadataReactor.ts";
import {
  deriveThreadGitMetadataPatch,
  type ThreadPullRequestLookup,
} from "../threadGitMetadata.ts";

const THREAD_GIT_METADATA_REACTOR_CAPACITY = 128;

type StartedEvent = Extract<ProviderRuntimeEvent, { type: "turn.started" }>;
type TerminalEvent = Extract<
  ProviderRuntimeEvent,
  { type: "turn.completed" | "turn.aborted" | "session.exited" | "runtime.error" }
>;
type VcsStateChangedEvent = Extract<ProviderRuntimeEvent, { type: "vcs.state.changed" }>;

interface ThreadWorkspaceContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly hasDedicatedWorktree: boolean;
}

interface CapturedThreadGitMetadata {
  readonly token: symbol;
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly expectedThreadBranch: string | null;
  readonly observedBranch: string | null;
  readonly upstreamRef: string | null;
  readonly hasDedicatedWorktree: boolean;
}

const turnKey = (threadId: ThreadId, turnId: string) => `${threadId}\0${turnId}`;

const serverCommandId = (): CommandId =>
  CommandId.makeUnsafe(`server:thread-git-metadata:${crypto.randomUUID()}`);

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const gitCore = yield* GitCore;
  const gitManager = yield* GitManager;

  const activeContextByTurnKey = new Map<string, ThreadWorkspaceContext>();
  const activeTurnKeysByCwd = new Map<string, Set<string>>();
  const ambiguousSharedTurnKeys = new Set<string>();
  const latestCaptureTokenByThread = new Map<ThreadId, symbol>();

  const resolveWorkspaceContext = Effect.fnUntraced(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<ThreadWorkspaceContext | null, ProjectionRepositoryError> {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    const thread = Option.getOrUndefined(threadOption);
    if (!thread) return null;

    const projectOption = yield* projectionSnapshotQuery.getProjectShellById(thread.projectId);
    const project = Option.getOrUndefined(projectOption);
    if (!project) return null;

    const cwd = resolveThreadWorkspaceCwd({ thread, projects: [project] });
    if (!cwd) return null;

    return {
      threadId,
      cwd,
      hasDedicatedWorktree: thread.worktreePath !== null,
    };
  });

  const addActiveContext = (key: string, context: ThreadWorkspaceContext) => {
    activeContextByTurnKey.set(key, context);
    const keys = activeTurnKeysByCwd.get(context.cwd) ?? new Set<string>();
    if (!context.hasDedicatedWorktree) {
      const otherKeys = [...keys].filter((candidate) => candidate !== key);
      if (otherKeys.length > 0) {
        ambiguousSharedTurnKeys.add(key);
        for (const otherKey of otherKeys) ambiguousSharedTurnKeys.add(otherKey);
      }
    }
    keys.add(key);
    activeTurnKeysByCwd.set(context.cwd, keys);
  };

  const removeActiveContext = (key: string) => {
    const context = activeContextByTurnKey.get(key);
    activeContextByTurnKey.delete(key);
    ambiguousSharedTurnKeys.delete(key);
    if (!context) return;
    const keys = activeTurnKeysByCwd.get(context.cwd);
    keys?.delete(key);
    if (keys?.size === 0) {
      activeTurnKeysByCwd.delete(context.cwd);
    }
  };

  const activeKeysForThread = (threadId: ThreadId): string[] =>
    [...activeContextByTurnKey.entries()]
      .filter(([, context]) => context.threadId === threadId)
      .map(([key]) => key);

  const trackTurnStart = Effect.fnUntraced(function* (event: StartedEvent) {
    if (event.turnId === undefined) return;
    const context = yield* resolveWorkspaceContext(event.threadId);
    if (!context) return;
    addActiveContext(turnKey(event.threadId, event.turnId), context);
  });

  const resolveTerminalContext = Effect.fnUntraced(function* (event: TerminalEvent) {
    const explicitKey = event.turnId === undefined ? null : turnKey(event.threadId, event.turnId);
    if (explicitKey) {
      const context = activeContextByTurnKey.get(explicitKey);
      if (context) return { context, activeKey: explicitKey };
      const fallbackContext = yield* resolveWorkspaceContext(event.threadId);
      return fallbackContext?.hasDedicatedWorktree
        ? { context: fallbackContext, activeKey: null }
        : null;
    }

    const threadKeys = activeKeysForThread(event.threadId);
    if (threadKeys.length === 1) {
      const activeKey = threadKeys[0]!;
      const context = activeContextByTurnKey.get(activeKey);
      if (context) return { context, activeKey };
    }

    const context = yield* resolveWorkspaceContext(event.threadId);
    return context?.hasDedicatedWorktree ? { context, activeKey: null } : null;
  });

  const captureTerminalMetadata = Effect.fnUntraced(function* (event: TerminalEvent) {
    const resolved = yield* resolveTerminalContext(event);
    if (!resolved) {
      if (event.type === "session.exited" || event.type === "runtime.error") {
        for (const key of activeKeysForThread(event.threadId)) removeActiveContext(key);
      }
      return;
    }
    const { context, activeKey } = resolved;

    const cleanup = Effect.sync(() => {
      if (activeKey) removeActiveContext(activeKey);
      if (event.type === "session.exited" || event.type === "runtime.error") {
        for (const key of activeKeysForThread(event.threadId)) removeActiveContext(key);
      }
    });

    yield* Effect.gen(function* () {
      const currentContext = yield* resolveWorkspaceContext(event.threadId);
      if (
        !currentContext ||
        currentContext.cwd !== context.cwd ||
        currentContext.hasDedicatedWorktree !== context.hasDedicatedWorktree
      ) {
        return;
      }

      if (!context.hasDedicatedWorktree) {
        const owners = activeTurnKeysByCwd.get(context.cwd);
        if (
          !activeKey ||
          ambiguousSharedTurnKeys.has(activeKey) ||
          owners?.size !== 1 ||
          !owners.has(activeKey)
        ) {
          return;
        }
      }

      yield* enqueueMetadataCapture(event.threadId, context, event.eventId);
    }).pipe(Effect.ensuring(cleanup));
  });

  const enqueueMetadataCapture = Effect.fnUntraced(function* (
    threadId: ThreadId,
    context: ThreadWorkspaceContext,
    eventId: string,
  ) {
    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(threadId);
    const thread = Option.getOrUndefined(threadOption);
    if (!thread) return;

    const details = yield* gitCore.readBranchContext(context.cwd);
    if (!details.isRepo) return;

    const token = Symbol(eventId);
    latestCaptureTokenByThread.set(threadId, token);
    yield* worker.enqueue({
      token,
      threadId,
      cwd: context.cwd,
      expectedThreadBranch: thread.branch,
      observedBranch: details.branch,
      upstreamRef: details.upstreamRef,
      hasDedicatedWorktree: context.hasDedicatedWorktree,
    });
  });

  // Mid-turn VCS transitions (commit/checkout/rebase) refresh the durable thread
  // metadata immediately; long-running turns would otherwise leave the projected
  // branch stale until the turn boundary reconciliation.
  const captureVcsMetadata = Effect.fnUntraced(function* (event: VcsStateChangedEvent) {
    const context = yield* resolveWorkspaceContext(event.threadId);
    if (!context) return;
    if (event.payload.cwd !== undefined && event.payload.cwd !== context.cwd) return;

    if (!context.hasDedicatedWorktree) {
      const threadKeys = activeKeysForThread(event.threadId);
      if (threadKeys.length !== 1) return;
      const activeKey = threadKeys[0]!;
      const owners = activeTurnKeysByCwd.get(context.cwd);
      if (ambiguousSharedTurnKeys.has(activeKey) || owners?.size !== 1 || !owners.has(activeKey)) {
        return;
      }
    }

    yield* enqueueMetadataCapture(event.threadId, context, event.eventId);
  });

  const lookupPullRequest = (
    captured: CapturedThreadGitMetadata,
  ): Effect.Effect<ThreadPullRequestLookup> => {
    if (captured.observedBranch === null) {
      return Effect.succeed({ status: "resolved", pullRequest: null });
    }
    return gitManager
      .pullRequestForBranch({
        cwd: captured.cwd,
        branch: captured.observedBranch,
        upstreamRef: captured.upstreamRef,
      })
      .pipe(
        Effect.map((pullRequest): ThreadPullRequestLookup => ({ status: "resolved", pullRequest })),
        Effect.catch((error) =>
          Effect.logDebug("thread git metadata PR lookup unavailable", {
            threadId: captured.threadId,
            branch: captured.observedBranch,
            error: error.message,
          }).pipe(Effect.as({ status: "unavailable" } as const)),
        ),
      );
  };

  const processCapturedMetadata = Effect.fnUntraced(function* (
    captured: CapturedThreadGitMetadata,
  ) {
    if (latestCaptureTokenByThread.get(captured.threadId) !== captured.token) return;
    const pullRequestLookup = yield* lookupPullRequest(captured);
    if (latestCaptureTokenByThread.get(captured.threadId) !== captured.token) return;

    const threadOption = yield* projectionSnapshotQuery.getThreadShellById(captured.threadId);
    const thread = Option.getOrUndefined(threadOption);
    if (!thread) return;
    if (latestCaptureTokenByThread.get(captured.threadId) !== captured.token) return;
    if (
      thread.branch !== captured.expectedThreadBranch &&
      thread.branch !== captured.observedBranch
    ) {
      return;
    }

    const patch = deriveThreadGitMetadataPatch({
      currentBranch: thread.branch,
      currentPullRequest: thread.lastKnownPr ?? null,
      observedBranch: captured.observedBranch,
      pullRequestLookup,
      ...(captured.hasDedicatedWorktree
        ? {
            dedicatedWorktree: {
              cwd: captured.cwd,
              currentPath: thread.associatedWorktreePath ?? null,
              currentBranch: thread.associatedWorktreeBranch ?? null,
            },
          }
        : {}),
    });
    if (!patch) return;

    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: serverCommandId(),
      threadId: captured.threadId,
      ...patch,
    });
  });

  const processCapturedMetadataSafely = (captured: CapturedThreadGitMetadata) =>
    processCapturedMetadata(captured).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("thread git metadata reconciliation failed", {
          threadId: captured.threadId,
          cause: Cause.pretty(cause),
        });
      }),
      Effect.ensuring(
        Effect.sync(() => {
          if (latestCaptureTokenByThread.get(captured.threadId) === captured.token) {
            latestCaptureTokenByThread.delete(captured.threadId);
          }
        }),
      ),
    );

  const worker = yield* makeDrainableWorker(processCapturedMetadataSafely, {
    capacity: THREAD_GIT_METADATA_REACTOR_CAPACITY,
  });

  const processProviderEvent = (event: ProviderRuntimeEvent) => {
    // Native subagent lifecycle events carry the parent Synara thread id and the child identity
    // in providerRefs. Treating them as parent turns would make shared-root ownership ambiguous
    // and suppress reconciliation when the actual parent turn completes.
    if (event.providerRefs?.providerParentThreadId !== undefined) return Effect.void;
    if (event.type === "turn.started") return trackTurnStart(event);
    if (event.type === "vcs.state.changed") return captureVcsMetadata(event);
    if (
      event.type === "turn.completed" ||
      event.type === "turn.aborted" ||
      event.type === "session.exited" ||
      event.type === "runtime.error"
    ) {
      return captureTerminalMetadata(event);
    }
    return Effect.void;
  };

  const processProviderEventSafely = (event: ProviderRuntimeEvent) =>
    processProviderEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("thread git metadata reactor failed to observe provider event", {
          eventType: event.type,
          threadId: event.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const start: ThreadGitMetadataReactorShape["start"] = startDrainableWorkerProducers(
    worker,
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        Stream.runForEach(providerService.streamEvents, processProviderEventSafely),
      );
    }),
  );

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadGitMetadataReactorShape;
});

export const ThreadGitMetadataReactorLive = Layer.effect(ThreadGitMetadataReactor, make);
