// FILE: threadRetention.ts
// Purpose: Runs the server-side retention loop that archives inactive orchestration threads.
// Layer: Server maintenance
// Exports: retention constants, archive-root selection, and scoped job startup.

import {
  CommandId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@synara/contracts";
import { automationContinuationThreadId } from "@synara/shared/automationMode";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore";
import { pruneProjectedArchivedManagedWorktrees } from "./managedWorktrees";
import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  AutomationRepository,
  type AutomationRepositoryShape,
} from "./persistence/Services/AutomationRepository";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";

// Stable prefix for retention commands. Older versions used it for reversible
// soft-deletes; current versions archive threads so users can restore them.
export const THREAD_RETENTION_COMMAND_ID_PREFIX = "thread-retention:";

export const THREAD_RETENTION_UNUSED_MS = 7 * 24 * 60 * 60 * 1000;
export const THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS = 5 * 60 * 1000;
export const THREAD_RETENTION_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const THREAD_RETENTION_BATCH_SIZE = 25;
const THREAD_RETENTION_BATCH_PAUSE_MS = 50;

type RetentionThread =
  | OrchestrationReadModel["threads"][number]
  | OrchestrationShellSnapshot["threads"][number];

type RetentionMaintenanceState = "started" | "progress" | "completed" | "failed";

function parseIsoMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// Never trust a single timestamp: forked/handoff threads inherit the source
// conversation's message timestamps, so `latestUserMessageAt` can predate the
// thread's own creation. The newest signal wins so a thread is only swept when
// every timestamp we have is past the cutoff.
function getThreadLastActivityMs(thread: RetentionThread): number | null {
  let lastActivityMs: number | null = null;
  for (const value of [thread.latestUserMessageAt, thread.updatedAt, thread.createdAt]) {
    const ms = parseIsoMs(value);
    if (ms === null) continue;
    if (lastActivityMs === null || ms > lastActivityMs) {
      lastActivityMs = ms;
    }
  }
  return lastActivityMs;
}

// Archiving is an explicit "keep this, out of my way" signal, so archived
// threads are never swept.
function isThreadArchived(thread: RetentionThread): boolean {
  return "archivedAt" in thread && (thread.archivedAt ?? null) !== null;
}

function isThreadDeleted(thread: RetentionThread): boolean {
  return "deletedAt" in thread && thread.deletedAt !== null;
}

function isThreadBusy(thread: RetentionThread): boolean {
  if (thread.session?.status === "starting" || thread.session?.status === "running") {
    return true;
  }
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }
  if (thread.latestTurn?.state === "running") {
    return true;
  }
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) {
    return true;
  }
  return false;
}

function listRetentionProtectedThreadIds(
  automationRepository: AutomationRepositoryShape,
): Effect.Effect<ReadonlySet<ThreadId>, unknown> {
  return automationRepository.list({ includeArchived: false }).pipe(
    Effect.map((result) => {
      const protectedThreadIds = new Set<ThreadId>();
      for (const definition of result.definitions) {
        // Any thread an enabled automation still continues, whether the user chose it
        // (heartbeat) or the automation created it for itself (dedicated).
        const continuationThreadId = automationContinuationThreadId(definition);
        if (definition.enabled && continuationThreadId !== null) {
          protectedThreadIds.add(continuationThreadId);
        }
      }
      return protectedThreadIds;
    }),
  );
}

function chunkThreadIds(
  threadIds: Iterable<ThreadId>,
  size = THREAD_RETENTION_BATCH_SIZE,
): ThreadId[][] {
  const chunks: ThreadId[][] = [];
  let chunk: ThreadId[] = [];
  for (const threadId of threadIds) {
    chunk.push(threadId);
    if (chunk.length < size) continue;
    chunks.push(chunk);
    chunk = [];
  }
  if (chunk.length > 0) {
    chunks.push(chunk);
  }
  return chunks;
}

const pauseBetweenRetentionBatches = Effect.sleep(THREAD_RETENTION_BATCH_PAUSE_MS);

const publishRetentionMaintenance = Effect.fn("publishRetentionMaintenance")(function* (
  state: RetentionMaintenanceState,
  details: {
    readonly deletedCount?: number;
    readonly totalCount?: number;
    readonly error?: string;
  } = {},
) {
  const lifecycleEvents = yield* ServerLifecycleEvents;
  yield* lifecycleEvents
    .publish({
      type: "maintenance",
      payload: {
        task: "thread-retention",
        state,
        at: new Date().toISOString(),
        ...details,
      },
    })
    .pipe(
      Effect.catch((error) =>
        Effect.logDebug("failed to publish thread retention maintenance event").pipe(
          Effect.annotateLogs({ state, error: String(error) }),
        ),
      ),
    );
});

function isThreadEligibleForRetention(
  thread: RetentionThread,
  cutoffMs: number,
  protectedThreadIds: ReadonlySet<ThreadId>,
): boolean {
  if (protectedThreadIds.has(thread.id)) return false;
  if (thread.isPinned === true) return false;
  if (isThreadBusy(thread)) return false;
  const lastActivityMs = getThreadLastActivityMs(thread);
  return lastActivityMs !== null && lastActivityMs <= cutoffMs;
}

// Archiving a parent also archives its active subagent subtree. Select only roots
// whose entire subtree is eligible, then omit eligible descendants that the root
// command will archive. This prevents retention from cascading over a protected,
// pinned, busy, or recent child and avoids duplicate archive commands.
export function getRetentionArchiveRootIds(
  readModel: Pick<OrchestrationReadModel, "threads"> | Pick<OrchestrationShellSnapshot, "threads">,
  nowMs = Date.now(),
  protectedThreadIds: ReadonlySet<ThreadId> = new Set(),
): ThreadId[] {
  const cutoffMs = nowMs - THREAD_RETENTION_UNUSED_MS;
  const activeThreads = new Map<ThreadId, RetentionThread>();

  for (const thread of readModel.threads) {
    if (isThreadDeleted(thread) || isThreadArchived(thread)) continue;
    activeThreads.set(thread.id, thread);
  }

  const eligibleThreadIds = new Set<ThreadId>();
  const childIdsByParentId = new Map<ThreadId, ThreadId[]>();
  for (const thread of activeThreads.values()) {
    if (isThreadEligibleForRetention(thread, cutoffMs, protectedThreadIds)) {
      eligibleThreadIds.add(thread.id);
    }
    const parentThreadId = thread.parentThreadId ?? null;
    if (parentThreadId === null || !activeThreads.has(parentThreadId)) continue;
    const childIds = childIdsByParentId.get(parentThreadId) ?? [];
    childIds.push(thread.id);
    childIdsByParentId.set(parentThreadId, childIds);
  }

  const archiveableSubtreeByThreadId = new Map<ThreadId, boolean>();
  const visitingThreadIds = new Set<ThreadId>();
  const canArchiveSubtree = (threadId: ThreadId): boolean => {
    const cached = archiveableSubtreeByThreadId.get(threadId);
    if (cached !== undefined) return cached;
    if (!eligibleThreadIds.has(threadId) || visitingThreadIds.has(threadId)) {
      return false;
    }
    visitingThreadIds.add(threadId);
    const canArchive = (childIdsByParentId.get(threadId) ?? []).every(canArchiveSubtree);
    visitingThreadIds.delete(threadId);
    archiveableSubtreeByThreadId.set(threadId, canArchive);
    return canArchive;
  };

  return [...activeThreads.values()]
    .filter((thread) => {
      const parentThreadId = thread.parentThreadId ?? null;
      const isActiveSubtreeRoot = parentThreadId === null || !activeThreads.has(parentThreadId);
      return isActiveSubtreeRoot && canArchiveSubtree(thread.id);
    })
    .map((thread) => thread.id);
}

export const runThreadRetentionSweep = Effect.fn("runThreadRetentionSweep")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  automationRepository: AutomationRepositoryShape,
  pruneArchivedManagedWorktrees: Effect.Effect<void, unknown>,
) {
  const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
  const protectedThreadIds = yield* listRetentionProtectedThreadIds(automationRepository);
  const archiveRootIds = getRetentionArchiveRootIds(shellSnapshot, Date.now(), protectedThreadIds);
  const totalCandidateCount = archiveRootIds.length;
  let archivedCount = 0;

  if (archiveRootIds.length > 0) {
    yield* publishRetentionMaintenance("started", {
      deletedCount: archivedCount,
      totalCount: totalCandidateCount,
    });
    yield* Effect.logInfo("archiving inactive orchestration threads").pipe(
      Effect.annotateLogs({ count: archiveRootIds.length }),
    );
  }

  yield* Effect.forEach(
    chunkThreadIds(archiveRootIds),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) =>
          orchestrationEngine
            .dispatch({
              type: "thread.archive",
              commandId: CommandId.makeUnsafe(
                `${THREAD_RETENTION_COMMAND_ID_PREFIX}${randomUUID()}`,
              ),
              threadId,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  archivedCount += 1;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("failed to archive inactive thread during retention sweep").pipe(
                  Effect.annotateLogs({
                    threadId,
                    error: String(error),
                  }),
                ),
              ),
            ),
        { concurrency: 1 },
      ).pipe(
        Effect.tap(() =>
          publishRetentionMaintenance("progress", {
            deletedCount: archivedCount,
            totalCount: totalCandidateCount,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  if (archivedCount > 0) {
    yield* pruneArchivedManagedWorktrees.pipe(
      Effect.catch((error) =>
        Effect.logWarning("managed worktree retention failed after thread retention sweep", {
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }

  if (totalCandidateCount > 0) {
    yield* publishRetentionMaintenance("completed", {
      deletedCount: archivedCount,
      totalCount: totalCandidateCount,
    });
  }
});

export const startThreadRetentionJob = Effect.fn("startThreadRetentionJob")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
) {
  const automationRepository = yield* AutomationRepository;
  const config = yield* ServerConfig;
  const git = yield* GitCore;
  const pruneArchivedManagedWorktrees = pruneProjectedArchivedManagedWorktrees({
    homeDir: config.homeDir,
    worktreesDir: config.worktreesDir,
    snapshotQuery: projectionSnapshotQuery,
    git,
  }).pipe(Effect.asVoid);
  // Give startup/projection bootstrap a short settling window, then run one
  // archive pass promptly so desktop installs do not need to stay open for 24 hours.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS);
    yield* runThreadRetentionSweep(
      orchestrationEngine,
      projectionSnapshotQuery,
      automationRepository,
      pruneArchivedManagedWorktrees,
    );
    yield* Effect.forever(
      Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(
        Effect.flatMap(() =>
          runThreadRetentionSweep(
            orchestrationEngine,
            projectionSnapshotQuery,
            automationRepository,
            pruneArchivedManagedWorktrees,
          ),
        ),
      ),
      { disableYield: true },
    );
  }).pipe(Effect.forkScoped);
});
