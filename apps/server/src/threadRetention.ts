// FILE: threadRetention.ts
// Purpose: Runs the server-side retention loop that hides inactive orchestration threads.
// Layer: Server maintenance
// Exports: retention constants, inactive-thread selection, and scoped job startup.

import {
  CommandId,
  type OrchestrationReadModel,
  type OrchestrationShellSnapshot,
  type ThreadId,
} from "@synara/contracts";
import { automationContinuationThreadId } from "@synara/shared/automationMode";
import { Effect } from "effect";
import { randomUUID } from "node:crypto";

import type { OrchestrationEngineShape } from "./orchestration/Services/OrchestrationEngine";
import type { ProjectionSnapshotQueryShape } from "./orchestration/Services/ProjectionSnapshotQuery";
import {
  AutomationRepository,
  type AutomationRepositoryShape,
} from "./persistence/Services/AutomationRepository";
import { ServerLifecycleEvents } from "./serverLifecycleEvents";

// Marks thread.delete commands issued by the retention sweep. Retention only
// hides threads from the app; deletion flows use this prefix to tell retention
// hides apart from explicit user deletes (which purge the thread's data).
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

// Picks inactive threads to soft-delete from the app while keeping their DB rows for stats.
export function getInactiveThreadIdsForRetention(
  readModel: Pick<OrchestrationReadModel, "threads"> | Pick<OrchestrationShellSnapshot, "threads">,
  nowMs = Date.now(),
  protectedThreadIds: ReadonlySet<ThreadId> = new Set(),
): ThreadId[] {
  const cutoffMs = nowMs - THREAD_RETENTION_UNUSED_MS;
  const inactiveThreadIds: ThreadId[] = [];

  for (const thread of readModel.threads) {
    if ("deletedAt" in thread && thread.deletedAt !== null) continue;
    if (protectedThreadIds.has(thread.id)) continue;
    if (thread.isPinned === true) continue;
    if (isThreadArchived(thread)) continue;
    if (isThreadBusy(thread)) continue;
    const lastActivityMs = getThreadLastActivityMs(thread);
    if (lastActivityMs === null || lastActivityMs > cutoffMs) continue;
    inactiveThreadIds.push(thread.id);
  }

  return inactiveThreadIds;
}

export const runThreadRetentionSweep = Effect.fn("runThreadRetentionSweep")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
  automationRepository: AutomationRepositoryShape,
) {
  const shellSnapshot = yield* projectionSnapshotQuery.getShellSnapshot();
  const protectedThreadIds = yield* listRetentionProtectedThreadIds(automationRepository);
  const inactiveThreadIds = getInactiveThreadIdsForRetention(
    shellSnapshot,
    Date.now(),
    protectedThreadIds,
  );
  const totalCandidateCount = inactiveThreadIds.length;
  let deletedCount = 0;

  if (inactiveThreadIds.length > 0) {
    yield* publishRetentionMaintenance("started", {
      deletedCount,
      totalCount: totalCandidateCount,
    });
    yield* Effect.logInfo("hiding inactive orchestration threads").pipe(
      Effect.annotateLogs({ count: inactiveThreadIds.length }),
    );
  }

  yield* Effect.forEach(
    chunkThreadIds(inactiveThreadIds),
    (threadBatch) =>
      Effect.forEach(
        threadBatch,
        (threadId) =>
          orchestrationEngine
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.makeUnsafe(
                `${THREAD_RETENTION_COMMAND_ID_PREFIX}${randomUUID()}`,
              ),
              threadId,
            })
            .pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  deletedCount += 1;
                }),
              ),
              Effect.catch((error) =>
                Effect.logWarning("failed to hide inactive thread during retention sweep").pipe(
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
            deletedCount,
            totalCount: totalCandidateCount,
          }),
        ),
        Effect.tap(() => pauseBetweenRetentionBatches),
      ),
    { concurrency: 1 },
  ).pipe(Effect.asVoid);

  if (totalCandidateCount > 0) {
    yield* publishRetentionMaintenance("completed", {
      deletedCount,
      totalCount: totalCandidateCount,
    });
  }
});

export const startThreadRetentionJob = Effect.fn("startThreadRetentionJob")(function* (
  orchestrationEngine: OrchestrationEngineShape,
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
) {
  const automationRepository = yield* AutomationRepository;
  // Give startup/projection bootstrap a short settling window, then run one
  // hide pass promptly so desktop installs do not need to stay open for 24 hours.
  yield* Effect.gen(function* () {
    yield* Effect.sleep(THREAD_RETENTION_INITIAL_SWEEP_DELAY_MS);
    yield* runThreadRetentionSweep(
      orchestrationEngine,
      projectionSnapshotQuery,
      automationRepository,
    );
    yield* Effect.forever(
      Effect.sleep(THREAD_RETENTION_SWEEP_INTERVAL_MS).pipe(
        Effect.flatMap(() =>
          runThreadRetentionSweep(
            orchestrationEngine,
            projectionSnapshotQuery,
            automationRepository,
          ),
        ),
      ),
      { disableYield: true },
    );
  }).pipe(Effect.forkScoped);
});
