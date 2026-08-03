import { ApprovalRequestId, CommandId, type OrchestrationEvent } from "@synara/contracts";
import {
  addPinnedMessage,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
} from "@synara/shared/pinnedMessages";
import {
  addThreadMarker,
  removeThreadMarker,
  setThreadMarkerDone,
  setThreadMarkerLabel,
} from "@synara/shared/threadMarkers";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Option, Path, Stream } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { toPersistenceSqlError, type ProjectionRepositoryError } from "../../persistence/Errors.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import {
  type ProjectionPendingInteractionRepositoryShape,
  ProjectionPendingInteractionRepository,
} from "../../persistence/Services/ProjectionPendingInteractions.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ProjectionSpaceRepository } from "../../persistence/Services/ProjectionSpaces.ts";
import { ProjectionStateRepository } from "../../persistence/Services/ProjectionState.ts";
import { ProjectionThreadActivityRepository } from "../../persistence/Services/ProjectionThreadActivities.ts";
import {
  type ProjectionThreadMessage,
  type ProjectionThreadMessageRepositoryShape,
  ProjectionThreadMessageRepository,
} from "../../persistence/Services/ProjectionThreadMessages.ts";
import {
  type ProjectionThreadProposedPlanRepositoryShape,
  ProjectionThreadProposedPlanRepository,
} from "../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepository } from "../../persistence/Services/ProjectionThreadSessions.ts";
import {
  type ProjectionTurn,
  ProjectionTurnRepository,
} from "../../persistence/Services/ProjectionTurns.ts";
import {
  type ProjectionThread,
  ProjectionThreadRepository,
} from "../../persistence/Services/ProjectionThreads.ts";
import { ProjectionPendingInteractionRepositoryLive } from "../../persistence/Layers/ProjectionPendingInteractions.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionSpaceRepositoryLive } from "../../persistence/Layers/ProjectionSpaces.ts";
import { ProjectionStateRepositoryLive } from "../../persistence/Layers/ProjectionState.ts";
import { ProjectionThreadActivityRepositoryLive } from "../../persistence/Layers/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "../../persistence/Layers/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadSessionRepositoryLive } from "../../persistence/Layers/ProjectionThreadSessions.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";
import { ProjectionThreadRepositoryLive } from "../../persistence/Layers/ProjectionThreads.ts";
import { ManagedAttachmentRepositoryLive } from "../../persistence/Layers/ManagedAttachments.ts";
import { ServerConfig } from "../../config.ts";
import {
  OrchestrationProjectionPipeline,
  type OrchestrationProjectionPipelineShape,
  type ShellMetadataOrchestrationEvent,
} from "../Services/ProjectionPipeline.ts";
import {
  applyProjectMetadataProjection,
  advanceProjectMetadataSnapshotState,
  PROJECT_METADATA_SNAPSHOT_PROJECTORS,
} from "../projectMetadataProjection.ts";
import { applySpaceMetadataProjection } from "../spaceMetadataProjection.ts";
import { resolveStableMessageTurnId } from "../messageTurnId.ts";
import { settleTurnStateFromSession } from "../turnLifecycle.ts";
import { deriveTurnStartModelSelection, deriveTurnStartSession } from "../turnStartSession.ts";
import {
  attachmentRelativePath,
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  toSafeThreadAttachmentSegment,
} from "../../attachmentStore.ts";
import {
  shouldApplyDeferredThreadShellSummary,
  shouldApplyThreadsProjection,
} from "../threadShellEvents.ts";

export const ORCHESTRATION_PROJECTOR_NAMES = {
  hot: "projection.hot",
  projects: "projection.projects",
  threads: "projection.threads",
  threadShellSummaries: "projection.thread-shell-summaries",
  threadMessages: "projection.thread-messages",
  threadProposedPlans: "projection.thread-proposed-plans",
  threadActivities: "projection.thread-activities",
  threadSessions: "projection.thread-sessions",
  threadTurns: "projection.thread-turns",
  checkpoints: "projection.checkpoints",
  // Preserve the established cursor identity. Migration 062 resets it so the
  // widened projector replays approval and user-input history exactly once.
  pendingInteractions: "projection.pending-approvals",
} as const;

type ProjectorName =
  (typeof ORCHESTRATION_PROJECTOR_NAMES)[keyof typeof ORCHESTRATION_PROJECTOR_NAMES];

interface ProjectorDefinition {
  readonly name: ProjectorName;
  readonly phase: "hot" | "deferred";
  readonly shouldApply?: (event: OrchestrationEvent) => boolean;
  readonly apply: (
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

interface AttachmentSideEffects {
  readonly deletedThreadIds: Set<string>;
  readonly prunedThreadRelativePaths: Map<string, Set<string>>;
}

function payloadRecord(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null
    ? (payload as Record<string, unknown>)
    : undefined;
}

function payloadNonEmptyString(payload: unknown, key: string): string | null {
  const value = payloadRecord(payload)?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function extractActivityRequestId(payload: unknown): ApprovalRequestId | null {
  const requestId = payloadRecord(payload)?.requestId;
  return typeof requestId === "string" ? ApprovalRequestId.makeUnsafe(requestId) : null;
}

function extractApprovalFailureSettlementStatus(
  payload: unknown,
): "retryable" | "uncertain" | null {
  const status = payloadRecord(payload)?.settlementStatus;
  return status === "retryable" || status === "uncertain" ? status : null;
}

const PROJECT_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "space.created",
  "space.meta-updated",
  "space.order-updated",
  "space.deleted",
  "project.created",
  "project.meta-updated",
  "project.deleted",
]);

const THREAD_MESSAGE_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.message-sent",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

const THREAD_PROPOSED_PLAN_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.proposed-plan-upserted",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

const THREAD_ACTIVITY_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.activity-appended",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

const THREAD_TURN_PROJECTION_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-start-requested",
  "thread.session-set",
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

function shouldApplyThreadTurnsProjection(event: OrchestrationEvent): boolean {
  return (
    THREAD_TURN_PROJECTION_EVENT_TYPES.has(event.type) ||
    (event.type === "thread.message-sent" &&
      event.payload.role === "assistant" &&
      event.payload.turnId !== null)
  );
}

function shouldApplyPendingInteractionsProjection(event: OrchestrationEvent): boolean {
  return (
    event.type === "thread.approval-response-requested" ||
    event.type === "thread.user-input-response-requested" ||
    (event.type === "thread.activity-appended" &&
      (event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "approval.resolved" ||
        event.payload.activity.kind === "provider.approval.respond.failed" ||
        event.payload.activity.kind === "user-input.requested" ||
        event.payload.activity.kind === "user-input.resolved" ||
        event.payload.activity.kind === "provider.user-input.respond.failed"))
  );
}

function maxIso(left: string | null, right: string): string {
  return left === null || right > left ? right : left;
}

// Destructive history edits are rare and rebuild from bounded/indexed summary queries.
const withRebuiltThreadShellSummary = Effect.fn(function* (input: {
  readonly thread: ProjectionThread;
  readonly projectionThreadMessageRepository: ProjectionThreadMessageRepositoryShape;
  readonly projectionThreadProposedPlanRepository: ProjectionThreadProposedPlanRepositoryShape;
  readonly projectionPendingInteractionRepository: ProjectionPendingInteractionRepositoryShape;
}) {
  const [latestUserMessageAt, latestPlan, pendingCounts] = yield* Effect.all([
    input.projectionThreadMessageRepository.getLatestUserMessageAt({
      threadId: input.thread.threadId,
    }),
    input.projectionThreadProposedPlanRepository.getLatestSummaryByThreadId({
      threadId: input.thread.threadId,
      preferredTurnId: input.thread.latestTurnId,
    }),
    input.projectionPendingInteractionRepository.getPendingCountsByThreadId({
      threadId: input.thread.threadId,
    }),
  ]);

  return {
    ...input.thread,
    latestUserMessageAt,
    pendingApprovalCount: pendingCounts.pendingApprovalCount,
    pendingUserInputCount: pendingCounts.pendingUserInputCount,
    hasActionableProposedPlan:
      Option.isSome(latestPlan) && latestPlan.value.implementedAt === null ? 1 : 0,
  } satisfies ProjectionThread;
});

const withRefreshedActionablePlanSummary = Effect.fn(function* (input: {
  readonly thread: ProjectionThread;
  readonly projectionThreadProposedPlanRepository: ProjectionThreadProposedPlanRepositoryShape;
}) {
  const latestPlan = yield* input.projectionThreadProposedPlanRepository.getLatestSummaryByThreadId(
    {
      threadId: input.thread.threadId,
      preferredTurnId: input.thread.latestTurnId,
    },
  );
  return {
    ...input.thread,
    hasActionableProposedPlan:
      Option.isSome(latestPlan) && latestPlan.value.implementedAt === null ? 1 : 0,
  } satisfies ProjectionThread;
});

function retainProjectionTurnsAfterRevert(
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionTurn> {
  return turns.filter(
    (turn) =>
      turn.turnId !== null &&
      turn.checkpointTurnCount !== null &&
      turn.checkpointTurnCount <= turnCount,
  );
}

function retainProjectionMessagesAfterRevert(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<ProjectionThreadMessage> {
  const retainedMessageIds = new Set<string>();
  const retainedTurnIds = new Set<string>();
  const keptTurns = retainProjectionTurnsAfterRevert(turns, turnCount);
  for (const turn of keptTurns) {
    if (turn.turnId !== null) {
      retainedTurnIds.add(turn.turnId);
    }
    if (turn.pendingMessageId !== null) {
      retainedMessageIds.add(turn.pendingMessageId);
    }
    if (turn.assistantMessageId !== null) {
      retainedMessageIds.add(turn.assistantMessageId);
    }
  }

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.messageId);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.messageId);
    }
  }

  for (const role of ["user", "assistant"] as const) {
    const retainedCount = messages.filter(
      (message) => message.role === role && retainedMessageIds.has(message.messageId),
    ).length;
    const missingCount = Math.max(0, turnCount - retainedCount);
    if (missingCount > 0) {
      for (const message of messages
        .filter(
          (message) =>
            message.role === role &&
            !retainedMessageIds.has(message.messageId) &&
            (message.turnId === null || retainedTurnIds.has(message.turnId)),
        )
        .slice(0, missingCount)) {
        retainedMessageIds.add(message.messageId);
      }
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.messageId));
}

function retainTurnScopedProjectionRowsAfterRevert<
  Row extends { readonly turnId: ProjectionTurn["turnId"] },
>(
  rows: ReadonlyArray<Row>,
  turns: ReadonlyArray<ProjectionTurn>,
  turnCount: number,
): ReadonlyArray<Row> {
  const retainedTurnIds = new Set(
    retainProjectionTurnsAfterRevert(turns, turnCount).flatMap((turn) =>
      turn.turnId === null ? [] : [turn.turnId],
    ),
  );
  return rows.filter((row) => row.turnId === null || retainedTurnIds.has(row.turnId));
}

function rollbackProjectionMessagesFromMessage(
  messages: ReadonlyArray<ProjectionThreadMessage>,
  messageId: string,
): {
  readonly keptRows: ReadonlyArray<ProjectionThreadMessage>;
  readonly removedTurnIds: ReadonlySet<string>;
  readonly changed: boolean;
} {
  const targetIndex = messages.findIndex((message) => message.messageId === messageId);
  if (targetIndex < 0) {
    return { keptRows: messages, removedTurnIds: new Set(), changed: false };
  }
  const removedRows = messages.slice(targetIndex);
  return {
    keptRows: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedRows.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    ),
    changed: true,
  };
}

function retainTurnScopedProjectionRowsAfterConversationRollback<
  Row extends { readonly turnId: string | null },
>(rows: ReadonlyArray<Row>, removedTurnIds: ReadonlySet<string>): ReadonlyArray<Row> {
  if (removedTurnIds.size === 0) return rows;
  return rows.filter((row) => row.turnId === null || !removedTurnIds.has(row.turnId));
}

function collectThreadAttachmentRelativePaths(
  threadId: string,
  messages: ReadonlyArray<ProjectionThreadMessage>,
): Set<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  const relativePaths = new Set<string>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image" && attachment.type !== "file") {
        continue;
      }
      if (attachment.id.startsWith("att_v2_")) {
        relativePaths.add(attachmentRelativePath(attachment));
        continue;
      }
      if (!threadSegment) {
        continue;
      }
      if (parseThreadSegmentFromAttachmentId(attachment.id) !== threadSegment) {
        continue;
      }
      relativePaths.add(attachmentRelativePath(attachment));
    }
  }
  return relativePaths;
}

const runAttachmentSideEffects = Effect.fn(function* (sideEffects: AttachmentSideEffects) {
  const serverConfig = yield* Effect.service(ServerConfig);
  const fileSystem = yield* Effect.service(FileSystem.FileSystem);
  const path = yield* Effect.service(Path.Path);

  const attachmentsRootDir = serverConfig.attachmentsDir;
  const attachmentRootEntries = yield* fileSystem
    .readDirectory(attachmentsRootDir, { recursive: false })
    .pipe(Effect.catch(() => Effect.succeed([] as Array<string>)));

  const resolveThreadAttachmentEntry = (threadSegment: string, entry: string) => {
    const relativePath = entry.replace(/^[/\\]+/, "").replace(/\\/g, "/");
    if (relativePath.length === 0 || relativePath.includes("/")) return undefined;
    const attachmentId = parseAttachmentIdFromRelativePath(relativePath);
    if (!attachmentId) return undefined;
    return parseThreadSegmentFromAttachmentId(attachmentId) === threadSegment
      ? relativePath
      : undefined;
  };

  yield* Effect.forEach(sideEffects.deletedThreadIds, (threadId) =>
    Effect.gen(function* () {
      const threadSegment = toSafeThreadAttachmentSegment(threadId);
      if (!threadSegment) {
        yield* Effect.logWarning("skipping attachment cleanup for unsafe thread id", {
          threadId,
        });
        return;
      }

      yield* Effect.forEach(attachmentRootEntries, (entry) => {
        const relativePath = resolveThreadAttachmentEntry(threadSegment, entry);
        return relativePath
          ? fileSystem.remove(path.join(attachmentsRootDir, relativePath), { force: true })
          : Effect.void;
      });
    }),
  );

  yield* Effect.forEach(
    sideEffects.prunedThreadRelativePaths.entries(),
    ([threadId, keptThreadRelativePaths]) => {
      if (sideEffects.deletedThreadIds.has(threadId)) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const threadSegment = toSafeThreadAttachmentSegment(threadId);
        if (!threadSegment) {
          yield* Effect.logWarning("skipping attachment prune for unsafe thread id", { threadId });
          return;
        }
        yield* Effect.forEach(attachmentRootEntries, (entry) =>
          Effect.gen(function* () {
            const relativePath = resolveThreadAttachmentEntry(threadSegment, entry);
            if (!relativePath) return;

            const absolutePath = path.join(attachmentsRootDir, relativePath);
            const fileInfo = yield* fileSystem
              .stat(absolutePath)
              .pipe(Effect.catch(() => Effect.succeed(null)));
            if (!fileInfo || fileInfo.type !== "File") return;

            if (!keptThreadRelativePaths.has(relativePath)) {
              yield* fileSystem.remove(absolutePath, { force: true });
            }
          }),
        );
      });
    },
  );
});

const makeOrchestrationProjectionPipeline = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const eventStore = yield* OrchestrationEventStore;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const projectionStateRepository = yield* ProjectionStateRepository;
  const projectionProjectRepository = yield* ProjectionProjectRepository;
  const projectionSpaceRepository = yield* ProjectionSpaceRepository;
  const projectionThreadRepository = yield* ProjectionThreadRepository;
  const projectionThreadMessageRepository = yield* ProjectionThreadMessageRepository;
  const projectionThreadProposedPlanRepository = yield* ProjectionThreadProposedPlanRepository;
  const projectionThreadActivityRepository = yield* ProjectionThreadActivityRepository;
  const projectionThreadSessionRepository = yield* ProjectionThreadSessionRepository;
  const projectionTurnRepository = yield* ProjectionTurnRepository;
  const projectionPendingInteractionRepository = yield* ProjectionPendingInteractionRepository;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;

  const applyProjectsProjection: ProjectorDefinition["apply"] = (event, _attachmentSideEffects) => {
    switch (event.type) {
      case "project.created":
      case "project.meta-updated":
      case "project.deleted":
        return applyProjectMetadataProjection({ event, projectionProjectRepository }).pipe(
          Effect.asVoid,
        );
      case "space.created":
      case "space.meta-updated":
      case "space.order-updated":
        return applySpaceMetadataProjection({ event, projectionSpaceRepository }).pipe(
          Effect.asVoid,
        );
      case "space.deleted":
        return applySpaceMetadataProjection({ event, projectionSpaceRepository }).pipe(
          Effect.andThen(
            projectionProjectRepository.clearSpaceAssignments({
              spaceId: event.payload.spaceId,
              updatedAt: event.payload.deletedAt,
            }),
          ),
          Effect.asVoid,
        );
      default:
        return Effect.void;
    }
  };

  const updateThreadProjection = Effect.fnUntraced(function* (
    threadId: ProjectionThread["threadId"],
    update: (thread: ProjectionThread) => ProjectionThread,
  ) {
    const existing = yield* projectionThreadRepository.getById({ threadId });
    if (Option.isSome(existing)) {
      yield* projectionThreadRepository.upsert(update(existing.value));
    }
  });

  const applyThreadsProjection: ProjectorDefinition["apply"] = (event, attachmentSideEffects) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.created": {
          const project = yield* projectionProjectRepository.getById({
            projectId: event.payload.projectId,
          });
          const isStudio = Option.isSome(project) && project.value.kind === "studio";
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            envMode: isStudio ? "local" : (event.payload.envMode ?? "local"),
            branch: isStudio ? null : event.payload.branch,
            worktreePath: isStudio ? null : event.payload.worktreePath,
            workingDirectory: isStudio
              ? (event.payload.workingDirectory ?? event.payload.worktreePath)
              : (event.payload.workingDirectory ?? null),
            associatedWorktreePath: isStudio
              ? null
              : (event.payload.associatedWorktreePath ?? null),
            associatedWorktreeBranch: isStudio
              ? null
              : (event.payload.associatedWorktreeBranch ?? null),
            associatedWorktreeRef: isStudio ? null : (event.payload.associatedWorktreeRef ?? null),
            createBranchFlowCompleted: isStudio
              ? false
              : (event.payload.createBranchFlowCompleted ?? false),
            isPinned: event.payload.isPinned ?? false,
            parentThreadId: event.payload.parentThreadId ?? null,
            creationSource: event.payload.creationSource ?? null,
            sourceThreadId: event.payload.sourceThreadId ?? null,
            sourceTurnId: event.payload.sourceTurnId ?? null,
            gatewayOperationId: event.payload.gatewayOperationId ?? null,
            gatewayOperationIndex: event.payload.gatewayOperationIndex ?? null,
            subagentAgentId: event.payload.subagentAgentId ?? null,
            subagentNickname: event.payload.subagentNickname ?? null,
            subagentRole: event.payload.subagentRole ?? null,
            forkSourceThreadId: event.payload.forkSourceThreadId,
            sidechatSourceThreadId: event.payload.sidechatSourceThreadId,
            lastKnownPr: event.payload.lastKnownPr ?? null,
            latestTurnId: null,
            handoff: event.payload.handoff,
            pinnedMessages: null,
            threadMarkers: null,
            notes: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledAt: null,
            deletedAt: null,
          });
          return;
        }

        case "thread.meta-updated": {
          const currentThread = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          const project = Option.isSome(currentThread)
            ? yield* projectionProjectRepository.getById({
                projectId: currentThread.value.projectId,
              })
            : Option.none();
          const isStudio = Option.isSome(project) && project.value.kind === "studio";
          return yield* updateThreadProjection(event.payload.threadId, (thread) => {
            const nextCreateBranchFlowCompleted =
              event.payload.createBranchFlowCompleted !== undefined
                ? event.payload.createBranchFlowCompleted
                : event.payload.branch !== undefined && event.payload.branch !== thread.branch
                  ? false
                  : undefined;
            return {
              ...thread,
              ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
              ...(event.payload.modelSelection !== undefined
                ? { modelSelection: event.payload.modelSelection }
                : {}),
              ...(isStudio
                ? {
                    envMode: "local" as const,
                    branch: null,
                    worktreePath: null,
                    workingDirectory:
                      event.payload.workingDirectory !== undefined
                        ? event.payload.workingDirectory
                        : event.payload.worktreePath !== undefined
                          ? event.payload.worktreePath
                          : (thread.workingDirectory ?? thread.worktreePath),
                  }
                : {
                    ...(event.payload.envMode !== undefined
                      ? { envMode: event.payload.envMode }
                      : {}),
                    ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
                    ...(event.payload.worktreePath !== undefined
                      ? { worktreePath: event.payload.worktreePath }
                      : {}),
                    ...(event.payload.workingDirectory !== undefined
                      ? { workingDirectory: event.payload.workingDirectory }
                      : {}),
                  }),
              ...(event.payload.associatedWorktreePath !== undefined
                ? { associatedWorktreePath: event.payload.associatedWorktreePath }
                : {}),
              ...(event.payload.associatedWorktreeBranch !== undefined
                ? { associatedWorktreeBranch: event.payload.associatedWorktreeBranch }
                : {}),
              ...(event.payload.associatedWorktreeRef !== undefined
                ? { associatedWorktreeRef: event.payload.associatedWorktreeRef }
                : {}),
              ...(nextCreateBranchFlowCompleted !== undefined
                ? { createBranchFlowCompleted: nextCreateBranchFlowCompleted }
                : {}),
              ...(isStudio
                ? {
                    associatedWorktreePath: null,
                    associatedWorktreeBranch: null,
                    associatedWorktreeRef: null,
                    createBranchFlowCompleted: false,
                  }
                : {}),
              ...(event.payload.isPinned !== undefined ? { isPinned: event.payload.isPinned } : {}),
              ...(event.payload.settledAt !== undefined
                ? { settledAt: event.payload.settledAt }
                : {}),
              ...(event.payload.parentThreadId !== undefined
                ? { parentThreadId: event.payload.parentThreadId }
                : {}),
              ...(event.payload.subagentAgentId !== undefined
                ? { subagentAgentId: event.payload.subagentAgentId }
                : {}),
              ...(event.payload.subagentNickname !== undefined
                ? { subagentNickname: event.payload.subagentNickname }
                : {}),
              ...(event.payload.subagentRole !== undefined
                ? { subagentRole: event.payload.subagentRole }
                : {}),
              ...(event.payload.lastKnownPr !== undefined
                ? { lastKnownPr: event.payload.lastKnownPr }
                : {}),
              ...(event.payload.handoff !== undefined ? { handoff: event.payload.handoff } : {}),
              ...(event.payload.pinnedMessages !== undefined
                ? { pinnedMessages: event.payload.pinnedMessages }
                : {}),
              ...(event.payload.threadMarkers !== undefined
                ? { threadMarkers: event.payload.threadMarkers }
                : {}),
              ...(event.payload.notes !== undefined ? { notes: event.payload.notes } : {}),
              updatedAt: event.payload.updatedAt,
            };
          });
        }

        case "thread.pinned-message-added":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            pinnedMessages: addPinnedMessage(thread.pinnedMessages, event.payload.pin),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.pinned-message-removed":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            pinnedMessages: removePinnedMessage(thread.pinnedMessages, event.payload.messageId),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.pinned-message-done-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            pinnedMessages: setPinnedMessageDone(
              thread.pinnedMessages,
              event.payload.messageId,
              event.payload.done,
            ),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.pinned-message-label-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            pinnedMessages: setPinnedMessageLabel(
              thread.pinnedMessages,
              event.payload.messageId,
              event.payload.label,
            ),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.marker-added":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            threadMarkers: addThreadMarker(thread.threadMarkers, event.payload.marker),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.marker-removed":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            threadMarkers: removeThreadMarker(thread.threadMarkers, event.payload.markerId),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.marker-done-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            threadMarkers: setThreadMarkerDone(
              thread.threadMarkers,
              event.payload.markerId,
              event.payload.done,
              event.payload.updatedAt,
            ),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.marker-label-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            threadMarkers: setThreadMarkerLabel(
              thread.threadMarkers,
              event.payload.markerId,
              event.payload.label,
              event.payload.updatedAt,
            ),
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.runtime-mode-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.interaction-mode-set":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          }));

        case "thread.turn-start-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const [messages, session] = yield* Effect.all([
            projectionThreadMessageRepository.listByThreadId({
              threadId: event.payload.threadId,
            }),
            projectionThreadSessionRepository.getByThreadId({
              threadId: event.payload.threadId,
            }),
          ]);
          const canAdoptFirstTurnProvider =
            existingRow.value.latestTurnId === null &&
            Option.isNone(session) &&
            messages.length <= 1;
          const projectedModelSelection = deriveTurnStartModelSelection({
            currentModelSelection: existingRow.value.modelSelection,
            requestedModelSelection: event.payload.modelSelection,
            canAdoptRequestedProvider: canAdoptFirstTurnProvider,
          });
          // Automation-dispatched turns run with the automation's modes but must not
          // repaint the thread's persisted modes: on a heartbeat target thread the
          // user's own composer selection has to survive the automation turn.
          const adoptTurnModes = event.payload.dispatchOrigin !== "automation";
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(projectedModelSelection !== existingRow.value.modelSelection
              ? { modelSelection: projectedModelSelection }
              : {}),
            ...(adoptTurnModes
              ? {
                  runtimeMode: event.payload.runtimeMode,
                  interactionMode: event.payload.interactionMode,
                }
              : {}),
            updatedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.deleted": {
          attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          }));
        }

        case "thread.archived": {
          const archivedAt =
            event.payload.archivedAt ?? event.payload.updatedAt ?? event.occurredAt;
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            archivedAt,
            updatedAt: event.payload.updatedAt ?? archivedAt,
          }));
        }

        case "thread.unarchived":
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            archivedAt: null,
            updatedAt: event.payload.updatedAt ?? event.payload.unarchivedAt ?? event.occurredAt,
          }));

        default:
          return;
      }
    });

  // Keep denormalized shell summary work out of the live transcript projector path.
  const applyThreadShellSummariesProjection: ProjectorDefinition["apply"] = (event) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent": {
          if (!shouldApplyDeferredThreadShellSummary(event)) {
            return;
          }
          return yield* updateThreadProjection(event.payload.threadId, (thread) => ({
            ...thread,
            latestUserMessageAt: maxIso(thread.latestUserMessageAt, event.payload.createdAt),
            updatedAt: event.occurredAt,
          }));
        }

        case "thread.proposed-plan-upserted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRefreshedActionablePlanSummary({
            thread: {
              ...existingRow.value,
              updatedAt: event.occurredAt,
            },
            projectionThreadProposedPlanRepository,
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRebuiltThreadShellSummary({
            thread: {
              ...existingRow.value,
              latestTurnId: null,
              updatedAt: event.occurredAt,
            },
            projectionThreadMessageRepository,
            projectionThreadProposedPlanRepository,
            projectionPendingInteractionRepository,
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        case "thread.session-set":
        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const nextRow = yield* withRefreshedActionablePlanSummary({
            thread: {
              ...existingRow.value,
              latestTurnId:
                event.type === "thread.session-set"
                  ? event.payload.session.activeTurnId
                  : event.payload.preserveLatestTurn
                    ? existingRow.value.latestTurnId
                    : event.payload.turnId,
              updatedAt: event.occurredAt,
            },
            projectionThreadProposedPlanRepository,
          });
          yield* projectionThreadRepository.upsert(nextRow);
          return;
        }

        default:
          return;
      }
    });

  /**
   * Streaming assistant deltas arrive one command per token chunk. Reading the
   * whole accumulated text back and concatenating it in JS made each delta pay
   * O(message length) in driver round-trips, schema decoding and JS string
   * building on top of the write.
   *
   * Appending in SQLite (`text = text || ?`) removes that read half only. SQLite
   * still rewrites the accumulated row and its overflow chain on every UPDATE,
   * so the storage work stays O(message length) per delta either way — this is
   * a constant-factor win (measured ~14%: 0.549 -> 0.473 ms/delta at 400 KB),
   * not a change in complexity. Removing the quadratic needs offset-addressed,
   * idempotent delta rows, which is a schema change.
   *
   * The append keeps the exact
   * column semantics of the read-modify-write upsert below:
   *  - `turn_id`   : `resolveStableMessageTurnId` (existing wins, else incoming)
   *  - optional JSON/enum columns: payload value when present, else untouched
   *  - `sequence`  : first writer wins
   *  - `created_at`: untouched (an existing row always carries one)
   *  - `role`/`source`/`is_streaming`/`updated_at`: replaced from the payload
   *
   * Returns false when the message row does not exist yet, so the caller falls
   * back to the insert path. Callers must already hold a transaction (every
   * projector pass runs inside one), which is what makes the miss-then-insert
   * sequence safe.
   *
   * TODO(persistence): this belongs on ProjectionThreadMessageRepository as an
   * `appendStreamingText` operation; it is inlined here only because this pass
   * may not edit the repository module.
   */
  const appendStreamingThreadMessageText = (
    event: Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>,
  ) =>
    sql<{ readonly messageId: string }>`
      UPDATE projection_thread_messages
      SET
        turn_id = COALESCE(turn_id, ${event.payload.turnId ?? null}),
        role = ${event.payload.role},
        text = text || ${event.payload.text},
        attachments_json = COALESCE(
          ${event.payload.attachments !== undefined ? JSON.stringify([...event.payload.attachments]) : null},
          attachments_json
        ),
        skills_json = COALESCE(
          ${event.payload.skills !== undefined ? JSON.stringify([...event.payload.skills]) : null},
          skills_json
        ),
        mentions_json = COALESCE(
          ${event.payload.mentions !== undefined ? JSON.stringify([...event.payload.mentions]) : null},
          mentions_json
        ),
        dispatch_mode = COALESCE(${event.payload.dispatchMode ?? null}, dispatch_mode),
        dispatch_origin = COALESCE(${event.payload.dispatchOrigin ?? null}, dispatch_origin),
        is_streaming = 1,
        source = ${event.payload.source},
        sequence = COALESCE(sequence, ${event.sequence}),
        updated_at = ${event.payload.updatedAt}
      WHERE thread_id = ${event.payload.threadId}
        AND message_id = ${event.payload.messageId}
      RETURNING message_id AS "messageId"
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(
        toPersistenceSqlError("ProjectionPipeline.appendStreamingThreadMessageText:query"),
      ),
    );

  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = (
    event,
    attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.message-sent": {
          // Hot path: append onto an existing streaming message without reading
          // the accumulated text back out of SQLite.
          if (event.payload.streaming && (yield* appendStreamingThreadMessageText(event))) {
            return;
          }
          const existingMessage = yield* projectionThreadMessageRepository.getByThreadAndMessageId({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
          });
          const nextAttachments =
            event.payload.attachments !== undefined
              ? event.payload.attachments
              : Option.isSome(existingMessage)
                ? existingMessage.value.attachments
                : undefined;
          yield* projectionThreadMessageRepository.upsert({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: resolveStableMessageTurnId({
              existingTurnId: Option.isSome(existingMessage) ? existingMessage.value.turnId : null,
              incomingTurnId: event.payload.turnId,
            }),
            role: event.payload.role,
            text:
              Option.isSome(existingMessage) && event.payload.streaming
                ? `${existingMessage.value.text}${event.payload.text}`
                : Option.isSome(existingMessage) && event.payload.text.length === 0
                  ? existingMessage.value.text
                  : event.payload.text,
            ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
            ...(event.payload.skills !== undefined ? { skills: event.payload.skills } : {}),
            ...(event.payload.mentions !== undefined ? { mentions: event.payload.mentions } : {}),
            ...(event.payload.dispatchMode !== undefined
              ? { dispatchMode: event.payload.dispatchMode }
              : {}),
            ...(event.payload.dispatchOrigin !== undefined
              ? { dispatchOrigin: event.payload.dispatchOrigin }
              : {}),
            isStreaming: event.payload.streaming,
            source: event.payload.source,
            sequence: Option.isSome(existingMessage)
              ? (existingMessage.value.sequence ?? event.sequence)
              : event.sequence,
            createdAt:
              (Option.isSome(existingMessage) ? existingMessage.value.createdAt : null) ??
              event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          if (event.type === "thread.conversation-rolled-back" && event.payload.numTurns === 0) {
            return;
          }
          const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          let keptRows: typeof existingRows;
          if (event.type === "thread.reverted") {
            keptRows = retainProjectionMessagesAfterRevert(
              existingRows,
              yield* projectionTurnRepository.listByThreadId({
                threadId: event.payload.threadId,
              }),
              event.payload.turnCount,
            );
            if (keptRows.length === existingRows.length) {
              return;
            }
          } else {
            const rollback = rollbackProjectionMessagesFromMessage(
              existingRows,
              event.payload.messageId,
            );
            if (!rollback.changed) {
              return;
            }
            keptRows = rollback.keptRows;
          }

          yield* projectionThreadMessageRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert);
          if (event.type === "thread.reverted" || event.payload.skipAttachmentPrune !== true) {
            attachmentSideEffects.prunedThreadRelativePaths.set(
              event.payload.threadId,
              collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
            );
          }
          return;
        }

        default:
          return;
      }
    });

  const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.proposed-plan-upserted":
          yield* projectionThreadProposedPlanRepository.upsert({
            planId: event.payload.proposedPlan.id,
            threadId: event.payload.threadId,
            turnId: event.payload.proposedPlan.turnId,
            planMarkdown: event.payload.proposedPlan.planMarkdown,
            implementedAt: event.payload.proposedPlan.implementedAt,
            implementationThreadId: event.payload.proposedPlan.implementationThreadId,
            createdAt: event.payload.proposedPlan.createdAt,
            updatedAt: event.payload.proposedPlan.updatedAt,
          });
          return;

        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const keptRows =
            event.type === "thread.reverted"
              ? retainTurnScopedProjectionRowsAfterRevert(
                  existingRows,
                  yield* projectionTurnRepository.listByThreadId({
                    threadId: event.payload.threadId,
                  }),
                  event.payload.turnCount,
                )
              : retainTurnScopedProjectionRowsAfterConversationRollback(
                  existingRows,
                  new Set(event.payload.removedTurnIds ?? []),
                );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadProposedPlanRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadActivitiesProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended":
          yield* projectionThreadActivityRepository.upsert({
            activityId: event.payload.activity.id,
            threadId: event.payload.threadId,
            turnId: event.payload.activity.turnId,
            tone: event.payload.activity.tone,
            kind: event.payload.activity.kind,
            summary: event.payload.activity.summary,
            payload: event.payload.activity.payload,
            // The orchestration log is durable and monotonic across provider
            // restarts, unlike provider-local counters that may reset to zero.
            sequence: event.sequence,
            createdAt: event.payload.activity.createdAt,
          });
          return;

        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          const existingRows = yield* projectionThreadActivityRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          if (existingRows.length === 0) {
            return;
          }
          const keptRows =
            event.type === "thread.reverted"
              ? retainTurnScopedProjectionRowsAfterRevert(
                  existingRows,
                  yield* projectionTurnRepository.listByThreadId({
                    threadId: event.payload.threadId,
                  }),
                  event.payload.turnCount,
                )
              : retainTurnScopedProjectionRowsAfterConversationRollback(
                  existingRows,
                  new Set(event.payload.removedTurnIds ?? []),
                );
          if (keptRows.length === existingRows.length) {
            return;
          }
          yield* projectionThreadActivityRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptRows, projectionThreadActivityRepository.upsert);
          return;
        }

        default:
          return;
      }
    });

  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          const [currentSession, thread] = yield* Effect.all([
            projectionThreadSessionRepository.getByThreadId({
              threadId: event.payload.threadId,
            }),
            projectionThreadRepository.getById({ threadId: event.payload.threadId }),
          ]);
          const turnStartSession = deriveTurnStartSession({
            threadId: event.payload.threadId,
            currentSession: Option.getOrNull(currentSession),
            providerName:
              Option.getOrNull(thread)?.modelSelection.provider ??
              Option.getOrNull(currentSession)?.providerName ??
              event.payload.modelSelection?.provider ??
              null,
            requestedRuntimeMode: event.payload.runtimeMode,
            requestedAt: event.payload.createdAt,
          });
          if (turnStartSession !== null) {
            yield* projectionThreadSessionRepository.upsert(turnStartSession);
          }
          return;
        }

        case "thread.session-set":
          yield* projectionThreadSessionRepository.upsert({
            threadId: event.payload.threadId,
            status: event.payload.session.status,
            providerName: event.payload.session.providerName,
            runtimeMode: event.payload.session.runtimeMode,
            activeTurnId: event.payload.session.activeTurnId,
            lastError: event.payload.session.lastError,
            updatedAt: event.payload.session.updatedAt,
          });
          return;

        default:
          return;
      }
    });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.turn-start-requested": {
          yield* projectionTurnRepository.replacePendingTurnStart({
            threadId: event.payload.threadId,
            messageId: event.payload.messageId,
            sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
            sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
            requestedAt: event.payload.createdAt,
          });
          return;
        }

        case "thread.session-set": {
          const turnId = event.payload.session.activeTurnId;
          if (event.payload.session.status !== "running" || turnId === null) {
            const settledState = settleTurnStateFromSession(event.payload.session, "running");
            if (settledState !== null) {
              // Close the newest still-open turn when the runtime reports that
              // the thread is no longer running. Error sessions may retain the
              // failed turn id for attribution, so prefer that exact open turn
              // before falling back to the newest open row.
              const openTurns = (yield* projectionTurnRepository.listByThreadId({
                threadId: event.payload.threadId,
              }))
                .filter(
                  (
                    row,
                  ): row is ProjectionTurn & {
                    turnId: Exclude<ProjectionTurn["turnId"], null>;
                  } => row.turnId !== null && row.completedAt === null,
                )
                .toSorted(
                  (left, right) =>
                    right.requestedAt.localeCompare(left.requestedAt) ||
                    right.turnId.localeCompare(left.turnId),
                );
              const turnToFinalize =
                (turnId === null ? undefined : openTurns.find((row) => row.turnId === turnId)) ??
                openTurns.at(0);

              if (turnToFinalize) {
                yield* projectionTurnRepository.upsertByTurnId({
                  ...turnToFinalize,
                  state:
                    settleTurnStateFromSession(event.payload.session, turnToFinalize.state) ??
                    turnToFinalize.state,
                  startedAt: turnToFinalize.startedAt ?? event.payload.session.updatedAt,
                  requestedAt: turnToFinalize.requestedAt ?? event.payload.session.updatedAt,
                  completedAt: event.payload.session.updatedAt,
                });
              }
            }
            return;
          }

          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId,
          });
          const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          if (Option.isSome(existingTurn)) {
            const nextState =
              existingTurn.value.state === "completed" || existingTurn.value.state === "error"
                ? existingTurn.value.state
                : "running";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              state: nextState,
              pendingMessageId:
                existingTurn.value.pendingMessageId ??
                (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
              sourceProposedPlanThreadId:
                existingTurn.value.sourceProposedPlanThreadId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanThreadId
                  : null),
              sourceProposedPlanId:
                existingTurn.value.sourceProposedPlanId ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.sourceProposedPlanId
                  : null),
              startedAt:
                existingTurn.value.startedAt ?? event.payload.session.updatedAt ?? event.occurredAt,
              requestedAt:
                existingTurn.value.requestedAt ??
                (Option.isSome(pendingTurnStart)
                  ? pendingTurnStart.value.requestedAt
                  : event.occurredAt),
            });
          } else {
            yield* projectionTurnRepository.upsertByTurnId({
              turnId,
              threadId: event.payload.threadId,
              pendingMessageId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.messageId
                : null,
              sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null,
              sourceProposedPlanId: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null,
              assistantMessageId: null,
              state: "running",
              requestedAt: Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt,
              // Keep `startedAt` tied to provider runtime start, not the earlier user dispatch.
              startedAt: event.payload.session.updatedAt ?? event.occurredAt,
              completedAt: null,
              checkpointTurnCount: null,
              checkpointRef: null,
              checkpointStatus: null,
              checkpointFiles: [],
            });
          }

          yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
            threadId: event.payload.threadId,
          });
          return;
        }

        case "thread.message-sent": {
          if (event.payload.turnId === null || event.payload.role !== "assistant") {
            return;
          }
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          if (Option.isSome(existingTurn)) {
            const existingIsTerminal =
              existingTurn.value.state === "completed" ||
              existingTurn.value.state === "error" ||
              existingTurn.value.state === "interrupted";
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              assistantMessageId: event.payload.messageId,
              state:
                event.payload.streaming && !existingIsTerminal
                  ? "running"
                  : existingTurn.value.state,
              completedAt:
                event.payload.streaming && !existingIsTerminal
                  ? null
                  : existingTurn.value.completedAt,
              startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.messageId,
            state: "running",
            requestedAt: event.payload.createdAt,
            startedAt: event.payload.createdAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
          return;
        }

        case "thread.turn-interrupt-requested": {
          // An interrupt request is only intent, not confirmation. The provider
          // can still reject it or time out, so we keep the persisted turn state
          // unchanged until a terminal runtime event arrives.
          return;
        }

        case "thread.task-stop-requested": {
          // Same as interrupts: intent only. Task state settles via the
          // provider's task lifecycle events.
          return;
        }

        case "thread.task-background-requested": {
          // Intent only: the provider confirms via a task_updated backgrounded patch.
          return;
        }

        case "thread.turn-diff-completed": {
          const existingTurn = yield* projectionTurnRepository.getByTurnId({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
          });
          const isProviderDiffPlaceholder =
            event.payload.status === "missing" &&
            event.payload.checkpointRef.startsWith("provider-diff:");
          const nextState = isProviderDiffPlaceholder
            ? Option.match(existingTurn, {
                onNone: () => "running" as const,
                onSome: (turn) => turn.state,
              })
            : event.payload.status === "error"
              ? "error"
              : "completed";
          yield* projectionTurnRepository.clearCheckpointTurnConflict({
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          });

          if (Option.isSome(existingTurn)) {
            yield* projectionTurnRepository.upsertByTurnId({
              ...existingTurn.value,
              // Preserve the persisted assistantMessageId when the event payload
              // is null. Placeholder turn-diff events can fire before the
              // assistant message is finalized; they must not erase a real id
              // recorded earlier by thread.message-sent.
              assistantMessageId:
                event.payload.assistantMessageId ?? existingTurn.value.assistantMessageId,
              state: nextState,
              checkpointTurnCount: event.payload.checkpointTurnCount,
              checkpointRef: event.payload.checkpointRef,
              checkpointStatus: event.payload.status,
              checkpointFiles: event.payload.files,
              startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
              requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
              completedAt: isProviderDiffPlaceholder
                ? existingTurn.value.completedAt
                : event.payload.completedAt,
            });
            return;
          }
          yield* projectionTurnRepository.upsertByTurnId({
            turnId: event.payload.turnId,
            threadId: event.payload.threadId,
            pendingMessageId: null,
            sourceProposedPlanThreadId: null,
            sourceProposedPlanId: null,
            assistantMessageId: event.payload.assistantMessageId,
            state: nextState,
            requestedAt: event.payload.completedAt,
            startedAt: event.payload.completedAt,
            completedAt: isProviderDiffPlaceholder ? null : event.payload.completedAt,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
          });
          return;
        }

        case "thread.reverted":
        case "thread.conversation-rolled-back": {
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          const keptTurns =
            event.type === "thread.reverted"
              ? retainProjectionTurnsAfterRevert(existingTurns, event.payload.turnCount)
              : retainTurnScopedProjectionRowsAfterConversationRollback(
                  existingTurns,
                  new Set(event.payload.removedTurnIds ?? []),
                );
          if (
            event.type === "thread.conversation-rolled-back" &&
            keptTurns.length === existingTurns.length
          ) {
            return;
          }
          yield* projectionTurnRepository.deleteByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(keptTurns, (turn) =>
            turn.turnId === null
              ? event.type === "thread.reverted" ||
                turn.pendingMessageId === null ||
                turn.state !== "pending" ||
                turn.checkpointTurnCount !== null
                ? Effect.void
                : projectionTurnRepository.replacePendingTurnStart({
                    threadId: turn.threadId,
                    messageId: turn.pendingMessageId,
                    sourceProposedPlanThreadId: turn.sourceProposedPlanThreadId,
                    sourceProposedPlanId: turn.sourceProposedPlanId,
                    requestedAt: turn.requestedAt,
                  })
              : projectionTurnRepository.upsertByTurnId({
                  ...turn,
                  turnId: turn.turnId,
                }),
          );
          return;
        }

        default:
          return;
      }
    });

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;

  const updatePendingInteractionShellCount = Effect.fn(function* (input: {
    readonly threadId: ProjectionThread["threadId"];
    readonly interactionKind: "approval" | "userInput";
    readonly previousStatus: string | null;
    readonly nextStatus: string;
    readonly updatedAt: string;
  }) {
    const delta =
      Number(input.nextStatus === "pending" || input.nextStatus === "retryable") -
      Number(input.previousStatus === "pending" || input.previousStatus === "retryable");
    return yield* updateThreadProjection(input.threadId, (thread) => ({
      ...thread,
      ...(input.interactionKind === "approval"
        ? {
            pendingApprovalCount: Math.max(0, thread.pendingApprovalCount + delta),
          }
        : {
            pendingUserInputCount: Math.max(0, thread.pendingUserInputCount + delta),
          }),
      updatedAt: input.updatedAt,
    }));
  });

  const applyPendingInteractionsProjection: ProjectorDefinition["apply"] = (
    event,
    _attachmentSideEffects,
  ) =>
    Effect.gen(function* () {
      switch (event.type) {
        case "thread.activity-appended": {
          const activity = event.payload.activity;
          const interactionKind =
            activity.kind === "approval.requested" ||
            activity.kind === "approval.resolved" ||
            activity.kind === "provider.approval.respond.failed"
              ? ("approval" as const)
              : activity.kind === "user-input.requested" ||
                  activity.kind === "user-input.resolved" ||
                  activity.kind === "provider.user-input.respond.failed"
                ? ("userInput" as const)
                : null;
          if (interactionKind === null) return;
          const requestId =
            extractActivityRequestId(activity.payload) ?? event.metadata.requestId ?? null;
          if (requestId === null) {
            return;
          }
          const existingRow = yield* projectionPendingInteractionRepository.getByIdentity({
            threadId: event.payload.threadId,
            interactionKind,
            requestId,
          });
          const lifecycleGeneration = payloadNonEmptyString(
            activity.payload,
            "lifecycleGeneration",
          );
          let nextRow: Parameters<typeof projectionPendingInteractionRepository.upsert>[0];
          if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
            if (
              lifecycleGeneration !== null &&
              Option.isSome(existingRow) &&
              existingRow.value.lifecycleGeneration !== lifecycleGeneration
            ) {
              return;
            }
            const resolvedDecisionRaw =
              interactionKind === "approval" ? payloadRecord(activity.payload)?.decision : null;
            nextRow = {
              interactionKind,
              requestId,
              threadId: event.payload.threadId,
              turnId: Option.isSome(existingRow) ? existingRow.value.turnId : activity.turnId,
              lifecycleGeneration: Option.isSome(existingRow)
                ? existingRow.value.lifecycleGeneration
                : lifecycleGeneration,
              status: "confirmed",
              decision:
                resolvedDecisionRaw === "accept" ||
                resolvedDecisionRaw === "acceptForSession" ||
                resolvedDecisionRaw === "decline" ||
                resolvedDecisionRaw === "cancel"
                  ? resolvedDecisionRaw
                  : null,
              responseCommandId: Option.isSome(existingRow)
                ? existingRow.value.responseCommandId
                : null,
              responseRequestedAt: Option.isSome(existingRow)
                ? existingRow.value.responseRequestedAt
                : null,
              createdAt: Option.isSome(existingRow)
                ? existingRow.value.createdAt
                : activity.createdAt,
              resolvedAt: activity.createdAt,
            } as const;
          } else if (
            activity.kind === "provider.approval.respond.failed" ||
            activity.kind === "provider.user-input.respond.failed"
          ) {
            if (Option.isNone(existingRow) || existingRow.value.status !== "responding") {
              return;
            }
            if (
              lifecycleGeneration !== null &&
              existingRow.value.lifecycleGeneration !== lifecycleGeneration
            ) {
              return;
            }
            const responseCommandIdValue = payloadNonEmptyString(
              activity.payload,
              "responseCommandId",
            );
            const responseCommandId = responseCommandIdValue
              ? CommandId.makeUnsafe(responseCommandIdValue)
              : null;
            if (
              responseCommandId === null ||
              existingRow.value.responseCommandId !== responseCommandId
            ) {
              return;
            }
            const nextStatus =
              extractApprovalFailureSettlementStatus(activity.payload) ?? "uncertain";
            nextRow = {
              ...existingRow.value,
              status: nextStatus,
              resolvedAt: null,
            };
          } else {
            if (
              activity.kind !== "approval.requested" &&
              activity.kind !== "user-input.requested"
            ) {
              return;
            }
            if (
              Option.isSome(existingRow) &&
              (existingRow.value.status === "responding" ||
                existingRow.value.status === "confirmed" ||
                existingRow.value.status === "uncertain") &&
              existingRow.value.lifecycleGeneration === lifecycleGeneration
            ) {
              return;
            }
            nextRow = {
              interactionKind,
              requestId,
              threadId: event.payload.threadId,
              turnId: activity.turnId,
              lifecycleGeneration,
              status: "pending",
              decision: null,
              responseCommandId: null,
              responseRequestedAt: null,
              createdAt:
                Option.isSome(existingRow) &&
                existingRow.value.lifecycleGeneration === lifecycleGeneration
                  ? existingRow.value.createdAt
                  : activity.createdAt,
              resolvedAt: null,
            } as const;
          }
          yield* projectionPendingInteractionRepository.upsert(nextRow);
          yield* updatePendingInteractionShellCount({
            threadId: event.payload.threadId,
            interactionKind,
            previousStatus: Option.isSome(existingRow) ? existingRow.value.status : null,
            nextStatus: nextRow.status,
            updatedAt: event.occurredAt,
          });
          return;
        }

        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          if (event.commandId === null) {
            return;
          }
          const interactionKind =
            event.type === "thread.approval-response-requested" ? "approval" : "userInput";
          const existingRow = yield* projectionPendingInteractionRepository.getByIdentity({
            threadId: event.payload.threadId,
            interactionKind,
            requestId: event.payload.requestId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          if (
            yield* projectionPendingInteractionRepository.claimResponse({
              threadId: event.payload.threadId,
              interactionKind,
              requestId: event.payload.requestId,
              lifecycleGeneration: event.payload.lifecycleGeneration ?? null,
              responseCommandId: event.commandId,
              decision:
                event.type === "thread.approval-response-requested" ? event.payload.decision : null,
              requestedAt: event.payload.createdAt,
            })
          ) {
            yield* updatePendingInteractionShellCount({
              threadId: event.payload.threadId,
              interactionKind,
              previousStatus: existingRow.value.status,
              nextStatus: "responding",
              updatedAt: event.occurredAt,
            });
          }
          return;
        }

        default:
          return;
      }
    });

  const projectors: ReadonlyArray<ProjectorDefinition> = [
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.projects,
      phase: "hot",
      shouldApply: (event) => PROJECT_EVENT_TYPES.has(event.type),
      apply: applyProjectsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadMessages,
      phase: "hot",
      shouldApply: (event) => THREAD_MESSAGE_PROJECTION_EVENT_TYPES.has(event.type),
      apply: applyThreadMessagesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans,
      phase: "hot",
      shouldApply: (event) => THREAD_PROPOSED_PLAN_PROJECTION_EVENT_TYPES.has(event.type),
      apply: applyThreadProposedPlansProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadActivities,
      phase: "hot",
      shouldApply: (event) => THREAD_ACTIVITY_PROJECTION_EVENT_TYPES.has(event.type),
      apply: applyThreadActivitiesProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threads,
      phase: "hot",
      shouldApply: shouldApplyThreadsProjection,
      apply: applyThreadsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadSessions,
      phase: "hot",
      shouldApply: (event) =>
        event.type === "thread.turn-start-requested" || event.type === "thread.session-set",
      apply: applyThreadSessionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadTurns,
      phase: "hot",
      shouldApply: shouldApplyThreadTurnsProjection,
      apply: applyThreadTurnsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.checkpoints,
      phase: "hot",
      shouldApply: () => false,
      apply: applyCheckpointsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.pendingInteractions,
      phase: "hot",
      shouldApply: shouldApplyPendingInteractionsProjection,
      apply: applyPendingInteractionsProjection,
    },
    {
      name: ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
      phase: "deferred",
      shouldApply: shouldApplyDeferredThreadShellSummary,
      apply: applyThreadShellSummariesProjection,
    },
  ];
  const projectsProjector = projectors.find(
    (projector) => projector.name === ORCHESTRATION_PROJECTOR_NAMES.projects,
  );

  // Project metadata changes only touch the project projection, so keep them
  // off the slower full-projector pass used by thread and runtime events.
  const selectProjectorsForEvent = (
    event: OrchestrationEvent,
    phase?: ProjectorDefinition["phase"],
  ): ReadonlyArray<ProjectorDefinition> => {
    const filterProjectors = (candidates: ReadonlyArray<ProjectorDefinition>) =>
      candidates.filter(
        (projector) =>
          (phase === undefined || projector.phase === phase) &&
          (projector.shouldApply?.(event) ?? true),
      );

    return filterProjectors(
      PROJECT_EVENT_TYPES.has(event.type) && projectsProjector ? [projectsProjector] : projectors,
    );
  };

  const runProjectorsForEventCore = (
    selectedProjectors: ReadonlyArray<ProjectorDefinition>,
    event: OrchestrationEvent,
    phaseCursor?: ProjectorName,
  ) =>
    Effect.gen(function* () {
      if (selectedProjectors.length === 0 && phaseCursor === undefined) {
        return null;
      }
      const attachmentSideEffects: AttachmentSideEffects = {
        deletedThreadIds: new Set<string>(),
        prunedThreadRelativePaths: new Map<string, Set<string>>(),
      };

      yield* Effect.forEach(selectedProjectors, (projector) =>
        projector.apply(event, attachmentSideEffects).pipe(
          Effect.flatMap(() => {
            if (projector.name === phaseCursor) {
              return Effect.void;
            }
            return projectionStateRepository.upsert({
              projector: projector.name,
              lastAppliedSequence: event.sequence,
              updatedAt: event.occurredAt,
            });
          }),
        ),
      );
      if (phaseCursor !== undefined) {
        yield* projectionStateRepository.upsert({
          projector: phaseCursor,
          lastAppliedSequence: event.sequence,
          updatedAt: event.occurredAt,
        });
      }
      for (const threadId of attachmentSideEffects.deletedThreadIds) {
        yield* managedAttachments.markCleanupByThread({
          ownerThreadId: threadId,
          reason: "thread-deleted",
          requestedAt: event.occurredAt,
        });
      }
      for (const [threadId, relativePaths] of attachmentSideEffects.prunedThreadRelativePaths) {
        yield* managedAttachments.markUnreferencedClaimedForCleanup({
          ownerThreadId: threadId,
          retainedAttachmentIds: [...relativePaths]
            .map(parseAttachmentIdFromRelativePath)
            .filter(
              (attachmentId): attachmentId is string =>
                attachmentId?.startsWith("att_v2_") === true,
            ),
          reason: "projection-pruned",
          requestedAt: event.occurredAt,
        });
      }

      return attachmentSideEffects;
    });

  const runProjectorAttachmentSideEffects = (
    selectedProjectors: ReadonlyArray<ProjectorDefinition>,
    event: OrchestrationEvent,
    attachmentSideEffects: AttachmentSideEffects | null,
  ) =>
    attachmentSideEffects === null
      ? Effect.void
      : runAttachmentSideEffects(attachmentSideEffects).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("failed to apply projected attachment side-effects", {
              projectors: selectedProjectors.map((projector) => projector.name),
              sequence: event.sequence,
              eventType: event.type,
              cause,
            }),
          ),
        );

  // A phase whose projectors all rejected the event still has to keep its cursor
  // moving, because the snapshot sequence exposed to clients is the minimum of
  // the phase cursors (see ProjectionSnapshotQuery.computeSnapshotSequence) and
  // a lagging cursor would make clients replay push events they already have.
  // The write is one idempotent upsert, so it does not need — and must not pay
  // for — an explicit transaction: SQLite already commits a lone statement
  // atomically. The deferred phase rejects every assistant delta, so this is the
  // difference between one transaction per streamed token and one statement.
  const advancePhaseCursorOnly = (event: OrchestrationEvent, phaseCursor: ProjectorName) =>
    projectionStateRepository.upsert({
      projector: phaseCursor,
      lastAppliedSequence: event.sequence,
      updatedAt: event.occurredAt,
    });

  const runProjectorsForEvent = (
    selectedProjectors: ReadonlyArray<ProjectorDefinition>,
    event: OrchestrationEvent,
    phaseCursor?: ProjectorName,
  ) =>
    Effect.gen(function* () {
      if (selectedProjectors.length === 0) {
        if (phaseCursor !== undefined) {
          yield* advancePhaseCursorOnly(event, phaseCursor);
        }
        return;
      }
      const attachmentSideEffects = yield* sql.withTransaction(
        runProjectorsForEventCore(selectedProjectors, event, phaseCursor),
      );
      yield* runProjectorAttachmentSideEffects(selectedProjectors, event, attachmentSideEffects);
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
    );

  const runProjectorsForHotEvent = (
    selectedProjectors: ReadonlyArray<ProjectorDefinition>,
    event: OrchestrationEvent,
    phaseCursor: ProjectorName,
  ) =>
    runProjectorsForEventCore(selectedProjectors, event, phaseCursor).pipe(
      Effect.flatMap((attachmentSideEffects) =>
        runProjectorAttachmentSideEffects(selectedProjectors, event, attachmentSideEffects),
      ),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig, serverConfig),
    );

  const initializeHotProjectionCursor = Effect.gen(function* () {
    const hotProjectorNames = new Set(
      projectors
        .filter((projector) => projector.phase === "hot")
        .map((projector) => projector.name),
    );
    const sourceRows = (yield* projectionStateRepository.listAll()).filter((row) =>
      hotProjectorNames.has(row.projector as ProjectorName),
    );
    if (sourceRows.length === 0) {
      return;
    }

    const oldestCursor = sourceRows.reduce((oldest, row) =>
      row.lastAppliedSequence < oldest.lastAppliedSequence ? row : oldest,
    );
    yield* projectionStateRepository.upsert({
      projector: ORCHESTRATION_PROJECTOR_NAMES.hot,
      lastAppliedSequence: oldestCursor.lastAppliedSequence,
      updatedAt: oldestCursor.updatedAt,
    });
  });

  const fastForwardHotProjectorCursors = Effect.gen(function* () {
    const stateRows = yield* projectionStateRepository.listAll();
    const stateByProjector = new Map(stateRows.map((row) => [row.projector, row] as const));
    const hotState = stateByProjector.get(ORCHESTRATION_PROJECTOR_NAMES.hot);
    if (!hotState) {
      return;
    }

    const laggingProjectors = projectors.filter((projector) => {
      if (projector.phase !== "hot") {
        return false;
      }
      const projectorState = stateByProjector.get(projector.name);
      return (
        projectorState !== undefined &&
        projectorState.lastAppliedSequence < hotState.lastAppliedSequence
      );
    });
    if (laggingProjectors.length === 0) {
      return;
    }

    // The hot cursor commits in the same transaction as every selected hot projector. A
    // lagging per-projector cursor therefore covers only events that its predicate rejected.
    // Align existing cursors before replay so a long-lived process does not rescan that backlog
    // on its next restart. Missing cursors still replay from the beginning for upgrade safety.
    yield* sql.withTransaction(
      Effect.forEach(laggingProjectors, (projector) =>
        projectionStateRepository.upsert({
          projector: projector.name,
          lastAppliedSequence: hotState.lastAppliedSequence,
          updatedAt: hotState.updatedAt,
        }),
      ),
    );
  });

  const advanceProjectorStateToEvent = (
    projector: ProjectorDefinition,
    event: OrchestrationEvent,
  ) =>
    projectionStateRepository.upsert({
      projector: projector.name,
      lastAppliedSequence: event.sequence,
      updatedAt: event.occurredAt,
    });

  const bootstrapProjector = (projector: ProjectorDefinition, highWaterSequence: number) =>
    projectionStateRepository
      .getByProjector({
        projector: projector.name,
      })
      .pipe(
        Effect.flatMap((stateRow) =>
          Effect.gen(function* () {
            let pendingSkippedEvent: OrchestrationEvent | null = null;

            yield* Stream.runForEach(
              eventStore.readFromSequence(
                Option.isSome(stateRow) ? stateRow.value.lastAppliedSequence : 0,
                Number.MAX_SAFE_INTEGER,
                highWaterSequence,
              ),
              (event) => {
                if (!(projector.shouldApply?.(event) ?? true)) {
                  pendingSkippedEvent = event;
                  return Effect.void;
                }

                pendingSkippedEvent = null;
                return runProjectorsForEvent([projector], event);
              },
            );

            // Preserve the replay cursor across trailing non-matching events without paying the
            // full projector transaction/apply cost for bootstrap no-ops.
            if (pendingSkippedEvent) {
              yield* advanceProjectorStateToEvent(projector, pendingSkippedEvent);
            }
          }),
        ),
      );

  const advanceSnapshotProjectorStates = (event: OrchestrationEvent) =>
    sql.withTransaction(
      Effect.forEach(PROJECT_METADATA_SNAPSHOT_PROJECTORS, (projector) =>
        projectionStateRepository.upsert({
          projector,
          lastAppliedSequence: event.sequence,
          updatedAt: event.occurredAt,
        }),
      ),
    );

  const applyShellMetadataProjection = (event: ShellMetadataOrchestrationEvent) => {
    switch (event.type) {
      case "space.created":
      case "space.meta-updated":
      case "space.order-updated":
        return applySpaceMetadataProjection({ event, projectionSpaceRepository });
      case "space.deleted":
        return applySpaceMetadataProjection({ event, projectionSpaceRepository }).pipe(
          Effect.andThen(
            projectionProjectRepository.clearSpaceAssignments({
              spaceId: event.payload.spaceId,
              updatedAt: event.payload.deletedAt,
            }),
          ),
        );
      case "project.created":
      case "project.meta-updated":
      case "project.deleted":
        return applyProjectMetadataProjection({ event, projectionProjectRepository });
    }
  };

  const projectMetadataEvent: OrchestrationProjectionPipelineShape["projectMetadataEvent"] = (
    event,
  ) =>
    applyShellMetadataProjection(event).pipe(
      Effect.flatMap(() =>
        advanceProjectMetadataSnapshotState({
          event,
          projectionStateRepository,
        }),
      ),
      Effect.asVoid,
    );

  const projectHotEventInCurrentTransaction: OrchestrationProjectionPipelineShape["projectHotEventInCurrentTransaction"] =
    (event) =>
      runProjectorsForHotEvent(
        selectProjectorsForEvent(event, "hot"),
        event,
        ORCHESTRATION_PROJECTOR_NAMES.hot,
      );

  const projectHotEventInOwnTransaction = (event: OrchestrationEvent) =>
    runProjectorsForEvent(
      selectProjectorsForEvent(event, "hot"),
      event,
      ORCHESTRATION_PROJECTOR_NAMES.hot,
    ).pipe(
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ProjectionPipeline.projectHotEventInOwnTransaction:query")(
            sqlError,
          ),
        ),
      ),
    );

  const projectDeferredEvent: OrchestrationProjectionPipelineShape["projectDeferredEvent"] = (
    event,
  ) =>
    runProjectorsForEvent(
      selectProjectorsForEvent(event, "deferred"),
      event,
      ORCHESTRATION_PROJECTOR_NAMES.threadShellSummaries,
    ).pipe(
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(
          toPersistenceSqlError("ProjectionPipeline.projectDeferredEvent:query")(sqlError),
        ),
      ),
    );

  const projectEvent: OrchestrationProjectionPipelineShape["projectEvent"] = (event) =>
    projectHotEventInOwnTransaction(event).pipe(
      Effect.andThen(projectDeferredEvent(event)),
      Effect.flatMap(() =>
        PROJECT_EVENT_TYPES.has(event.type) ? advanceSnapshotProjectorStates(event) : Effect.void,
      ),
      Effect.asVoid,
      Effect.catchTag("SqlError", (sqlError) =>
        Effect.fail(toPersistenceSqlError("ProjectionPipeline.projectEvent:query")(sqlError)),
      ),
    );

  const bootstrap: OrchestrationProjectionPipelineShape["bootstrap"] = Effect.gen(function* () {
    yield* fastForwardHotProjectorCursors;
    const highWaterSequence = yield* eventStore.getHighWaterSequence();
    yield* Effect.forEach(projectors, (projector) =>
      bootstrapProjector(projector, highWaterSequence),
    );
    yield* initializeHotProjectionCursor;
  }).pipe(
    Effect.tap(() =>
      Effect.log("orchestration projection pipeline bootstrapped").pipe(
        Effect.annotateLogs({ projectors: projectors.length }),
      ),
    ),
    Effect.catchTag("SqlError", (sqlError) =>
      Effect.fail(toPersistenceSqlError("ProjectionPipeline.bootstrap:query")(sqlError)),
    ),
  );

  return {
    bootstrap,
    projectEvent,
    projectHotEventInCurrentTransaction,
    projectDeferredEvent,
    projectMetadataEvent,
  } satisfies OrchestrationProjectionPipelineShape;
});

export const OrchestrationProjectionPipelineLive = Layer.effect(
  OrchestrationProjectionPipeline,
  makeOrchestrationProjectionPipeline,
).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(ProjectionProjectRepositoryLive),
  Layer.provideMerge(ProjectionSpaceRepositoryLive),
  Layer.provideMerge(ProjectionThreadRepositoryLive),
  Layer.provideMerge(ProjectionThreadMessageRepositoryLive),
  Layer.provideMerge(ProjectionThreadProposedPlanRepositoryLive),
  Layer.provideMerge(ProjectionThreadActivityRepositoryLive),
  Layer.provideMerge(ProjectionThreadSessionRepositoryLive),
  Layer.provideMerge(ProjectionTurnRepositoryLive),
  Layer.provideMerge(ProjectionPendingInteractionRepositoryLive),
  Layer.provideMerge(ProjectionStateRepositoryLive),
  Layer.provideMerge(ManagedAttachmentRepositoryLive),
);
