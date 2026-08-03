import type { OrchestrationEvent, OrchestrationReadModel, ThreadId } from "@synara/contracts";
import {
  OrchestrationCheckpointSummary,
  OrchestrationMessage,
  OrchestrationSession,
  OrchestrationThread,
} from "@synara/contracts";
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
import { Effect, Schema } from "effect";

import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  MessageSentPayloadSchema,
  SpaceCreatedPayload,
  SpaceDeletedPayload,
  SpaceMetaUpdatedPayload,
  SpaceOrderUpdatedPayload,
  ProjectCreatedPayload,
  ProjectDeletedPayload,
  ProjectMetaUpdatedPayload,
  ThreadArchivedPayload,
  ThreadActivityAppendedPayload,
  ThreadCreatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadPinnedMessageAddedPayload,
  ThreadPinnedMessageDoneSetPayload,
  ThreadPinnedMessageLabelSetPayload,
  ThreadPinnedMessageRemovedPayload,
  ThreadMarkerAddedPayload,
  ThreadMarkerDoneSetPayload,
  ThreadMarkerLabelSetPayload,
  ThreadMarkerRemovedPayload,
  ThreadProposedPlanUpsertedPayload,
  ThreadConversationRolledBackPayload,
  ThreadRuntimeModeSetPayload,
  ThreadUnarchivedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnStartRequestedPayload,
} from "./Schemas.ts";
import { resolveStableMessageTurnId } from "./messageTurnId.ts";
import { settleTurnStateFromSession } from "./turnLifecycle.ts";
import { deriveTurnStartModelSelection, deriveTurnStartSession } from "./turnStartSession.ts";

type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;
const MAX_THREAD_MESSAGES = 2_000;
const MAX_THREAD_ACTIVITIES = 500;
const MAX_THREAD_CHECKPOINTS = 500;

function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;
  if (status === "missing") return "interrupted" as const;
  return "completed" as const;
}

function isProviderDiffPlaceholderRef(checkpointRef: string | null | undefined): boolean {
  return checkpointRef?.startsWith("provider-diff:") === true;
}

function isTerminalLatestTurn(
  latestTurn: OrchestrationThread["latestTurn"] | null | undefined,
): boolean {
  if (!latestTurn?.completedAt) {
    return false;
  }
  return latestTurn.state === "completed" || latestTurn.state === "error";
}

// Turn lifecycle must settle with the session: once a session leaves "running",
// no provider event will ever mark the turn complete on its own, so a running
// latestTurn is settled here. Checkpoint diff events (thread.turn-diff-completed)
// only enrich the terminal state afterwards — they are not the lifecycle authority.
// A retained activeTurnId blocks settlement (except on error): stop-requested flows
// deliberately emit "interrupted" while keeping the turn active until the provider's
// terminal event decides the real outcome, and a premature settle here could never
// be corrected because settlement only applies to running turns.
function settleLatestTurnForSessionStatus(
  latestTurn: OrchestrationThread["latestTurn"],
  session: Pick<OrchestrationSession, "status" | "activeTurnId" | "updatedAt">,
): OrchestrationThread["latestTurn"] {
  if (latestTurn?.state !== "running") {
    return latestTurn;
  }
  const settledState = settleTurnStateFromSession(session, latestTurn.state);
  if (settledState === null) {
    return latestTurn;
  }
  return {
    ...latestTurn,
    state: settledState,
    completedAt: latestTurn.completedAt ?? session.updatedAt,
  };
}

// Every projected event patches exactly one thread, and streaming assistant
// deltas run this on the dispatch hot path, so patch the single affected slot
// instead of mapping a closure over every thread.
function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): OrchestrationThread[] {
  const nextThreads = threads.slice();
  const index = nextThreads.findIndex((thread) => thread.id === threadId);
  if (index === -1) {
    return nextThreads;
  }
  nextThreads[index] = { ...nextThreads[index]!, ...patch };
  return nextThreads;
}

// Message ids are unique within a thread and streamed deltas land on the newest
// message, so searching backwards finds the target in one step instead of
// scanning the whole (capped at MAX_THREAD_MESSAGES) transcript.
function findMessageIndexFromEnd(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]!.id === messageId) {
      return index;
    }
  }
  return -1;
}

function decodeForEvent<A>(
  schema: Schema.Schema<A>,
  value: unknown,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(schema as any)(value),
    catch: (error) => toProjectorDecodeError(`${eventType}:${field}`)(error as Schema.SchemaError),
  });
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;
  const missingUserCount = Math.max(0, turnCount - retainedUserCount);
  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .slice(0, missingUserCount);
    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;
  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);
  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  messageId: string,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages, removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  return {
    messages: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedMessages.flatMap((message) => (message.turnId === null ? [] : [message.turnId])),
    ),
  };
}

function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function upsertThreadActivity(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  activity: OrchestrationThread["activities"][number],
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  const existingIndex = activities.findIndex((entry) => entry.id === activity.id);
  if (existingIndex >= 0 && compareThreadActivities(activities[existingIndex]!, activity) === 0) {
    const next = [...activities];
    next[existingIndex] = activity;
    return next.slice(-MAX_THREAD_ACTIVITIES);
  }

  const withoutExisting =
    existingIndex < 0
      ? activities
      : [...activities.slice(0, existingIndex), ...activities.slice(existingIndex + 1)];
  const last = withoutExisting.at(-1);
  if (!last || compareThreadActivities(last, activity) <= 0) {
    return [...withoutExisting, activity].slice(-MAX_THREAD_ACTIVITIES);
  }

  let low = 0;
  let high = withoutExisting.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareThreadActivities(withoutExisting[middle]!, activity) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return [...withoutExisting.slice(0, low), activity, ...withoutExisting.slice(low)].slice(
    -MAX_THREAD_ACTIVITIES,
  );
}

export function createEmptyReadModel(nowIso: string): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    spaces: [],
    projects: [],
    threads: [],
    updatedAt: nowIso,
  };
}

export function projectEvent(
  model: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  const nextBase: OrchestrationReadModel = {
    ...model,
    snapshotSequence: event.sequence,
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "space.created":
      return decodeForEvent(SpaceCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.spaces.find((entry) => entry.id === payload.spaceId);
          const nextSpace = {
            id: payload.spaceId,
            name: payload.name,
            icon: payload.icon,
            sortOrder: payload.sortOrder,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };
          return {
            ...nextBase,
            spaces: existing
              ? nextBase.spaces.map((entry) => (entry.id === payload.spaceId ? nextSpace : entry))
              : [...nextBase.spaces, nextSpace],
          };
        }),
      );

    case "space.meta-updated":
      return decodeForEvent(SpaceMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? {
                  ...space,
                  ...(payload.name !== undefined ? { name: payload.name } : {}),
                  ...(payload.icon !== undefined ? { icon: payload.icon } : {}),
                  updatedAt: payload.updatedAt,
                }
              : space,
          ),
        })),
      );

    case "space.order-updated":
      return decodeForEvent(SpaceOrderUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const orderBySpaceId = new Map(
            payload.orderedSpaceIds.map((spaceId, index) => [spaceId, index] as const),
          );
          return {
            ...nextBase,
            spaces: nextBase.spaces.map((space) => {
              const sortOrder = orderBySpaceId.get(space.id);
              // A listed space whose position did not move is not a change; skipping it keeps
              // this read model, the SQL projection, and the client store byte-identical.
              return sortOrder === undefined || sortOrder === space.sortOrder
                ? space
                : { ...space, sortOrder, updatedAt: payload.updatedAt };
            }),
          };
        }),
      );

    case "space.deleted":
      return decodeForEvent(SpaceDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          spaces: nextBase.spaces.map((space) =>
            space.id === payload.spaceId
              ? { ...space, deletedAt: payload.deletedAt, updatedAt: payload.deletedAt }
              : space,
          ),
          projects: nextBase.projects.map((project) =>
            project.spaceId === payload.spaceId
              ? {
                  ...project,
                  spaceId: null,
                  updatedAt:
                    project.updatedAt > payload.deletedAt ? project.updatedAt : payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "project.created":
      return decodeForEvent(ProjectCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.projects.find((entry) => entry.id === payload.projectId);
          const nextProject = {
            id: payload.projectId,
            kind: payload.kind,
            title: payload.title,
            workspaceRoot: payload.workspaceRoot,
            defaultModelSelection: payload.defaultModelSelection,
            scripts: payload.scripts,
            isPinned: payload.isPinned ?? false,
            spaceId: payload.spaceId ?? null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            deletedAt: null,
          };

          return {
            ...nextBase,
            projects: existing
              ? nextBase.projects.map((entry) =>
                  entry.id === payload.projectId ? nextProject : entry,
                )
              : [...nextBase.projects, nextProject],
          };
        }),
      );

    case "project.meta-updated":
      return decodeForEvent(ProjectMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  ...(payload.kind !== undefined ? { kind: payload.kind } : {}),
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.workspaceRoot !== undefined
                    ? { workspaceRoot: payload.workspaceRoot }
                    : {}),
                  ...(payload.defaultModelSelection !== undefined
                    ? { defaultModelSelection: payload.defaultModelSelection }
                    : {}),
                  ...(payload.scripts !== undefined ? { scripts: payload.scripts } : {}),
                  ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
                  ...(payload.spaceId !== undefined ? { spaceId: payload.spaceId } : {}),
                  updatedAt: payload.updatedAt,
                }
              : project,
          ),
        })),
      );

    case "project.deleted":
      return decodeForEvent(ProjectDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          projects: nextBase.projects.map((project) =>
            project.id === payload.projectId
              ? {
                  ...project,
                  deletedAt: payload.deletedAt,
                  updatedAt: payload.deletedAt,
                }
              : project,
          ),
        })),
      );

    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const isStudio =
          nextBase.projects.find((project) => project.id === payload.projectId)?.kind === "studio";
        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            envMode: isStudio ? "local" : payload.envMode,
            branch: isStudio ? null : payload.branch,
            worktreePath: isStudio ? null : payload.worktreePath,
            workingDirectory: isStudio
              ? (payload.workingDirectory ?? payload.worktreePath)
              : payload.workingDirectory,
            associatedWorktreePath: isStudio ? null : payload.associatedWorktreePath,
            associatedWorktreeBranch: isStudio ? null : payload.associatedWorktreeBranch,
            associatedWorktreeRef: isStudio ? null : payload.associatedWorktreeRef,
            createBranchFlowCompleted: isStudio ? false : payload.createBranchFlowCompleted,
            isPinned: payload.isPinned,
            parentThreadId: payload.parentThreadId,
            creationSource: payload.creationSource ?? null,
            sourceThreadId: payload.sourceThreadId ?? null,
            sourceTurnId: payload.sourceTurnId ?? null,
            gatewayOperationId: payload.gatewayOperationId ?? null,
            gatewayOperationIndex: payload.gatewayOperationIndex ?? null,
            subagentAgentId: payload.subagentAgentId,
            subagentNickname: payload.subagentNickname,
            subagentRole: payload.subagentRole,
            forkSourceThreadId: payload.forkSourceThreadId,
            sidechatSourceThreadId: payload.sidechatSourceThreadId,
            lastKnownPr: payload.lastKnownPr ?? null,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledAt: null,
            deletedAt: null,
            handoff: payload.handoff,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );
        const existing = nextBase.threads.find((entry) => entry.id === thread.id);
        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });

    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );

    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const archivedAt = payload.archivedAt ?? payload.updatedAt ?? event.occurredAt;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt,
              updatedAt: payload.updatedAt ?? archivedAt,
            }),
          };
        }),
      );

    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const updatedAt = payload.updatedAt ?? payload.unarchivedAt ?? event.occurredAt;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              archivedAt: null,
              updatedAt,
            }),
          };
        }),
      );

    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          const isStudio =
            nextBase.projects.find((project) => project.id === existingThread?.projectId)?.kind ===
            "studio";
          const nextCreateBranchFlowCompleted =
            payload.createBranchFlowCompleted !== undefined
              ? payload.createBranchFlowCompleted
              : payload.branch !== undefined &&
                  existingThread !== null &&
                  payload.branch !== existingThread.branch
                ? false
                : undefined;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...(payload.title !== undefined ? { title: payload.title } : {}),
              ...(payload.modelSelection !== undefined
                ? { modelSelection: payload.modelSelection }
                : {}),
              ...(isStudio
                ? {
                    envMode: "local" as const,
                    branch: null,
                    worktreePath: null,
                    workingDirectory:
                      payload.workingDirectory !== undefined
                        ? payload.workingDirectory
                        : payload.worktreePath !== undefined
                          ? payload.worktreePath
                          : (existingThread?.workingDirectory ??
                            existingThread?.worktreePath ??
                            null),
                  }
                : {
                    ...(payload.envMode !== undefined ? { envMode: payload.envMode } : {}),
                    ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
                    ...(payload.worktreePath !== undefined
                      ? { worktreePath: payload.worktreePath }
                      : {}),
                    ...(payload.workingDirectory !== undefined
                      ? { workingDirectory: payload.workingDirectory }
                      : {}),
                  }),
              ...(payload.associatedWorktreePath !== undefined
                ? { associatedWorktreePath: payload.associatedWorktreePath }
                : {}),
              ...(payload.associatedWorktreeBranch !== undefined
                ? { associatedWorktreeBranch: payload.associatedWorktreeBranch }
                : {}),
              ...(payload.associatedWorktreeRef !== undefined
                ? { associatedWorktreeRef: payload.associatedWorktreeRef }
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
              ...(payload.isPinned !== undefined ? { isPinned: payload.isPinned } : {}),
              ...(payload.settledAt !== undefined ? { settledAt: payload.settledAt } : {}),
              ...(payload.parentThreadId !== undefined
                ? { parentThreadId: payload.parentThreadId }
                : {}),
              ...(payload.subagentAgentId !== undefined
                ? { subagentAgentId: payload.subagentAgentId }
                : {}),
              ...(payload.subagentNickname !== undefined
                ? { subagentNickname: payload.subagentNickname }
                : {}),
              ...(payload.subagentRole !== undefined ? { subagentRole: payload.subagentRole } : {}),
              ...(payload.lastKnownPr !== undefined ? { lastKnownPr: payload.lastKnownPr } : {}),
              ...(payload.handoff !== undefined ? { handoff: payload.handoff } : {}),
              ...(payload.pinnedMessages !== undefined
                ? { pinnedMessages: payload.pinnedMessages }
                : {}),
              ...(payload.threadMarkers !== undefined
                ? { threadMarkers: payload.threadMarkers }
                : {}),
              ...(payload.notes !== undefined ? { notes: payload.notes } : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-added":
      return decodeForEvent(
        ThreadPinnedMessageAddedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: addPinnedMessage(existingThread?.pinnedMessages, payload.pin),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-removed":
      return decodeForEvent(
        ThreadPinnedMessageRemovedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: removePinnedMessage(
                existingThread?.pinnedMessages,
                payload.messageId,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-done-set":
      return decodeForEvent(
        ThreadPinnedMessageDoneSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageDone(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.done,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.pinned-message-label-set":
      return decodeForEvent(
        ThreadPinnedMessageLabelSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              pinnedMessages: setPinnedMessageLabel(
                existingThread?.pinnedMessages,
                payload.messageId,
                payload.label,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-added":
      return decodeForEvent(ThreadMarkerAddedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: addThreadMarker(existingThread?.threadMarkers, payload.marker),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-removed":
      return decodeForEvent(ThreadMarkerRemovedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: removeThreadMarker(existingThread?.threadMarkers, payload.markerId),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-done-set":
      return decodeForEvent(ThreadMarkerDoneSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerDone(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.done,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.marker-label-set":
      return decodeForEvent(ThreadMarkerLabelSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existingThread =
            nextBase.threads.find((thread) => thread.id === payload.threadId) ?? null;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              threadMarkers: setThreadMarkerLabel(
                existingThread?.threadMarkers,
                payload.markerId,
                payload.label,
                payload.updatedAt,
              ),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }
          const canAdoptFirstTurnProvider =
            thread.latestTurn === null && thread.session === null && thread.messages.length <= 1;
          const projectedModelSelection = deriveTurnStartModelSelection({
            currentModelSelection: thread.modelSelection,
            requestedModelSelection: payload.modelSelection,
            canAdoptRequestedProvider: canAdoptFirstTurnProvider,
          });
          const modelSelectionPatch =
            projectedModelSelection !== thread.modelSelection
              ? { modelSelection: projectedModelSelection }
              : {};
          const turnStartSession = deriveTurnStartSession({
            threadId: thread.id,
            currentSession: thread.session,
            providerName: projectedModelSelection.provider,
            requestedRuntimeMode: payload.runtimeMode,
            requestedAt: payload.createdAt,
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              ...modelSelectionPatch,
              ...(turnStartSession !== null ? { session: turnStartSession } : {}),
              runtimeMode: payload.runtimeMode,
              interactionMode: payload.interactionMode,
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );

    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
            ...(payload.mentions !== undefined ? { mentions: payload.mentions } : {}),
            turnId: payload.turnId,
            streaming: payload.streaming,
            source: payload.source,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        // Hot path: one streamed delta must not cost a full copy-and-rebuild of
        // the transcript. Update the one affected slot in a single shallow copy
        // and only re-cap when the transcript actually grew past the limit.
        const existingIndex = findMessageIndexFromEnd(thread.messages, message.id);
        let cappedMessages: ReadonlyArray<OrchestrationMessage>;
        if (existingIndex >= 0) {
          const entry = thread.messages[existingIndex]!;
          const nextMessages = thread.messages.slice();
          nextMessages[existingIndex] = {
            ...entry,
            text: message.streaming
              ? `${entry.text}${message.text}`
              : message.text.length > 0
                ? message.text
                : entry.text,
            streaming: message.streaming,
            source: message.source,
            updatedAt: message.updatedAt,
            turnId: resolveStableMessageTurnId({
              existingTurnId: entry.turnId,
              incomingTurnId: message.turnId,
            }),
            ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            ...(message.skills !== undefined ? { skills: message.skills } : {}),
            ...(message.mentions !== undefined ? { mentions: message.mentions } : {}),
          };
          cappedMessages = nextMessages;
        } else {
          cappedMessages =
            thread.messages.length >= MAX_THREAD_MESSAGES
              ? [
                  ...thread.messages.slice(thread.messages.length - MAX_THREAD_MESSAGES + 1),
                  message,
                ]
              : [...thread.messages, message];
        }

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? thread.latestTurn?.turnId === session.activeTurnId &&
                  isTerminalLatestTurn(thread.latestTurn)
                  ? thread.latestTurn
                  : {
                      turnId: session.activeTurnId,
                      state: "running",
                      requestedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.requestedAt
                          : session.updatedAt,
                      startedAt:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? (thread.latestTurn.startedAt ?? session.updatedAt)
                          : session.updatedAt,
                      completedAt: null,
                      assistantMessageId:
                        thread.latestTurn?.turnId === session.activeTurnId
                          ? thread.latestTurn.assistantMessageId
                          : null,
                    }
                : settleLatestTurnForSessionStatus(thread.latestTurn, session),
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);
        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Preserve the previous latestTurn assistantMessageId when the
        // incoming payload has none. Turn-diff placeholders can fire before
        // the assistant message is finalized — they must not erase a real id
        // that thread.message-sent has already recorded.
        const preservedAssistantMessageId =
          payload.assistantMessageId ??
          (thread.latestTurn?.turnId === payload.turnId
            ? thread.latestTurn.assistantMessageId
            : null);
        const previousLatestCheckpointTurnCount = thread.checkpoints.find(
          (entry) => entry.turnId === thread.latestTurn?.turnId,
        )?.checkpointTurnCount;
        const preservesNewerLatestTurn =
          payload.preserveLatestTurn === true ||
          (previousLatestCheckpointTurnCount !== undefined &&
            previousLatestCheckpointTurnCount > payload.checkpointTurnCount);
        const latestTurn = preservesNewerLatestTurn
          ? thread.latestTurn
          : // A provider-diff placeholder only carries live diff totals; it must never
            // change the turn lifecycle — neither close a running turn nor flip an
            // already-settled one to "interrupted" when it loses the race against
            // session settlement.
            isProviderDiffPlaceholderRef(payload.checkpointRef) &&
              payload.status === "missing" &&
              thread.latestTurn?.turnId === payload.turnId
            ? thread.latestTurn
            : {
                turnId: payload.turnId,
                state: checkpointStatusToLatestTurnState(payload.status),
                requestedAt:
                  thread.latestTurn?.turnId === payload.turnId
                    ? thread.latestTurn.requestedAt
                    : payload.completedAt,
                startedAt:
                  thread.latestTurn?.turnId === payload.turnId
                    ? (thread.latestTurn.startedAt ?? payload.completedAt)
                    : payload.completedAt,
                completedAt: payload.completedAt,
                assistantMessageId: preservedAssistantMessageId,
              };

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });

    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;
          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.conversation-rolled-back":
      return decodeForEvent(
        ThreadConversationRolledBackPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          if (payload.numTurns === 0) {
            return nextBase;
          }
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const rollback = rollbackThreadMessagesFromMessage(thread.messages, payload.messageId);
          if (rollback.messages === thread.messages) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((checkpoint) => !rollback.removedTurnIds.has(checkpoint.turnId))
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);
          const proposedPlans = thread.proposedPlans
            .filter((plan) => plan.turnId === null || !rollback.removedTurnIds.has(plan.turnId))
            .slice(-200);
          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !rollback.removedTurnIds.has(activity.turnId),
          );
          const latestCheckpoint = checkpoints.at(-1) ?? null;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages: rollback.messages.slice(-MAX_THREAD_MESSAGES),
              proposedPlans,
              activities,
              latestTurn:
                latestCheckpoint === null
                  ? null
                  : {
                      turnId: latestCheckpoint.turnId,
                      state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                      requestedAt: latestCheckpoint.completedAt,
                      startedAt: latestCheckpoint.completedAt,
                      completedAt: latestCheckpoint.completedAt,
                      assistantMessageId: latestCheckpoint.assistantMessageId,
                    },
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) {
            return nextBase;
          }

          const activities = upsertThreadActivity(thread.activities, {
            ...payload.activity,
            sequence: event.sequence,
          });

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );

    default:
      return Effect.succeed(nextBase);
  }
}
