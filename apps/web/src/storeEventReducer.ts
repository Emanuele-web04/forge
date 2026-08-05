// FILE: storeEventReducer.ts
// Purpose: Reduces ordered orchestration domain events into normalized client state.
// Exports: Normal and hot-path event batch reducers.

import {
  type OrchestrationEvent,
  type OrchestrationPendingInteraction,
  type ThreadId,
} from "@synara/contracts";
import { resolveThreadBranchRegressionGuard } from "@synara/shared/git";
import {
  addPinnedMessage,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
} from "@synara/shared/pinnedMessages";
import { isPendingInteractionResponseClaimable } from "@synara/shared/pendingInteractions";
import {
  addThreadMarker,
  removeThreadMarker,
  setThreadMarkerDone,
  setThreadMarkerLabel,
} from "@synara/shared/threadMarkers";

import { isSessionRunningTurn } from "./session-logic";
import {
  MAX_THREAD_MESSAGES,
  arraysShallowEqual,
  asActivityRecord,
  createThreadActivityAccumulator,
  deepEqualJson,
  normalizeActivities,
  normalizeChatMessage,
  normalizeModelSelection,
  normalizeProposedPlans,
  normalizeThreadErrorMessage,
  normalizeThreadSession,
  normalizeTurnDiffFiles,
  providerReferenceArraysEqual,
  resolveCreateBranchFlowCompletedMerge,
  withOrchestrationEventSequence,
} from "./storeNormalization";
import {
  applySpaceOrder,
  applyThreadUpdate,
  removeSpace,
  removeDeletedProjectFromClientState,
  removeDeletedThreadFromClientState,
  upsertProject,
  upsertSpace,
} from "./storeProjection";
import type { AppState } from "./storeState";
import type { ChatMessage, Thread } from "./types";

type ThreadMessageSentEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;
type ThreadActivityAppendedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.activity-appended" }
>;
type ThreadApprovalResponseRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.approval-response-requested" }
>;
type ThreadUserInputResponseRequestedEvent = Extract<
  OrchestrationEvent,
  { type: "thread.user-input-response-requested" }
>;
export type ApplyOrchestrationEventOptions = {
  updateSidebarSummary?: boolean;
};

type ReadModelThread = import("@synara/contracts").OrchestrationReadModel["threads"][number];

const THREAD_SUMMARY_ACTIVITY_KINDS = new Set([
  "approval.requested",
  "approval.resolved",
  "provider.approval.respond.failed",
  "user-input.requested",
  "user-input.resolved",
  "provider.user-input.respond.failed",
]);

function resolveEventUpdatedAt(thread: Thread, updatedAt: string): string {
  const currentUpdatedAt = thread.updatedAt ?? thread.createdAt;
  return currentUpdatedAt > updatedAt ? currentUpdatedAt : updatedAt;
}

function threadMessageUpdatesSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user";
}

function threadActivityUpdatesSummary(event: ThreadActivityAppendedEvent): boolean {
  return THREAD_SUMMARY_ACTIVITY_KINDS.has(event.payload.activity.kind);
}

function threadMessageUpdatesSidebarSummary(event: ThreadMessageSentEvent): boolean {
  return event.payload.role === "user" || !event.payload.streaming;
}

function markInteractionResponding(
  thread: Thread,
  event: ThreadUserInputResponseRequestedEvent | ThreadApprovalResponseRequestedEvent,
): Thread["pendingInteractions"] {
  if (thread.pendingInteractions === undefined || event.commandId === null) {
    return thread.pendingInteractions;
  }
  const interactionKind =
    event.type === "thread.approval-response-requested" ? "approval" : "userInput";
  const lifecycleGeneration = event.payload.lifecycleGeneration ?? null;
  let changed = false;
  const next = thread.pendingInteractions.map((interaction) => {
    if (
      interaction.interactionKind !== interactionKind ||
      interaction.requestId !== event.payload.requestId ||
      interaction.lifecycleGeneration !== lifecycleGeneration ||
      !isPendingInteractionResponseClaimable({
        status: interaction.status,
        responseRequestedAt: interaction.responseRequestedAt,
        requestedAt: event.payload.createdAt,
      })
    ) {
      return interaction;
    }
    changed = true;
    return {
      ...interaction,
      status: "responding" as const,
      decision: event.type === "thread.approval-response-requested" ? event.payload.decision : null,
      responseCommandId: event.commandId,
      responseRequestedAt: event.payload.createdAt,
      resolvedAt: null,
    };
  });
  return changed ? next : thread.pendingInteractions;
}

/** Pure reconciliation over the pending-interaction list alone: batch callers thread the
 *  accumulated list through directly instead of cloning the whole `Thread` per event. */
function reconcilePendingInteractionsFromActivity(
  threadId: ThreadId,
  pendingInteractions: Thread["pendingInteractions"],
  event: ThreadActivityAppendedEvent,
): Thread["pendingInteractions"] {
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
  if (interactionKind === null) {
    return pendingInteractions;
  }
  const payload = asActivityRecord(activity.payload);
  const requestId = payload?.requestId;
  if (typeof requestId !== "string" || requestId.length === 0) {
    return pendingInteractions;
  }
  const lifecycleGeneration =
    typeof payload?.lifecycleGeneration === "string" && payload.lifecycleGeneration.length > 0
      ? payload.lifecycleGeneration
      : null;
  const existing = pendingInteractions ?? [];
  const matchesIdentity = (interaction: OrchestrationPendingInteraction) =>
    interaction.interactionKind === interactionKind &&
    interaction.requestId === requestId &&
    (lifecycleGeneration === null || interaction.lifecycleGeneration === lifecycleGeneration);

  if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
    const next = existing.filter((interaction) => !matchesIdentity(interaction));
    return next.length === existing.length ? pendingInteractions : next;
  }

  if (
    activity.kind === "provider.approval.respond.failed" ||
    activity.kind === "provider.user-input.respond.failed"
  ) {
    const responseCommandId = payload?.responseCommandId;
    if (typeof responseCommandId !== "string" || responseCommandId.length === 0) {
      return pendingInteractions;
    }
    const settlementStatus: OrchestrationPendingInteraction["status"] =
      payload?.settlementStatus === "retryable" ? "retryable" : "uncertain";
    let changed = false;
    const next = existing.map((interaction) => {
      if (
        !matchesIdentity(interaction) ||
        interaction.status !== "responding" ||
        interaction.responseCommandId !== responseCommandId
      ) {
        return interaction;
      }
      changed = true;
      return { ...interaction, status: settlementStatus, resolvedAt: null };
    });
    return changed ? next : pendingInteractions;
  }

  const exactIndex = existing.findIndex(
    (interaction) =>
      interaction.interactionKind === interactionKind && interaction.requestId === requestId,
  );
  const current = exactIndex >= 0 ? existing[exactIndex] : undefined;
  if (
    current &&
    current.lifecycleGeneration === lifecycleGeneration &&
    (current.status === "responding" ||
      current.status === "confirmed" ||
      current.status === "uncertain")
  ) {
    return pendingInteractions;
  }
  const pending: OrchestrationPendingInteraction = {
    interactionKind,
    requestId: requestId as OrchestrationPendingInteraction["requestId"],
    threadId,
    turnId: activity.turnId,
    lifecycleGeneration,
    status: "pending",
    decision: null,
    responseCommandId: null,
    responseRequestedAt: null,
    createdAt:
      current?.lifecycleGeneration === lifecycleGeneration ? current.createdAt : activity.createdAt,
    resolvedAt: null,
  };
  if (exactIndex < 0) {
    return [...existing, pending];
  }
  const next = [...existing];
  next[exactIndex] = pending;
  return next;
}

function normalizeSingleTurnDiffSummary(
  incoming: Thread["turnDiffSummaries"][number],
  previous: Thread["turnDiffSummaries"][number] | undefined,
): Thread["turnDiffSummaries"][number] {
  const files = normalizeTurnDiffFiles(incoming.files, previous?.files);
  if (
    previous &&
    previous.turnId === incoming.turnId &&
    previous.completedAt === incoming.completedAt &&
    previous.status === incoming.status &&
    previous.assistantMessageId === incoming.assistantMessageId &&
    previous.checkpointTurnCount === incoming.checkpointTurnCount &&
    previous.checkpointRef === incoming.checkpointRef &&
    previous.files === files
  ) {
    return previous;
  }
  return {
    ...incoming,
    files,
  };
}

function sortTurnDiffSummaries(
  summaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
): Thread["turnDiffSummaries"] {
  return [...summaries].toSorted(
    (left, right) =>
      (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
        (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) ||
      left.completedAt.localeCompare(right.completedAt) ||
      left.turnId.localeCompare(right.turnId),
  );
}

function checkpointStatusToLatestTurnState(
  status: Thread["turnDiffSummaries"][number]["status"],
): NonNullable<Thread["latestTurn"]>["state"] {
  if (status === "error") {
    return "error";
  }
  if (status === "missing") {
    return "interrupted";
  }
  return "completed";
}

function isProviderDiffPlaceholderRef(checkpointRef: string | null | undefined): boolean {
  return checkpointRef?.startsWith("provider-diff:") === true;
}

function buildLatestTurn(params: {
  previous: Thread["latestTurn"];
  turnId: NonNullable<Thread["latestTurn"]>["turnId"];
  state: NonNullable<Thread["latestTurn"]>["state"];
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"];
  sourceProposedPlan?: Thread["pendingSourceProposedPlan"];
}): NonNullable<Thread["latestTurn"]> {
  const sourceProposedPlan =
    params.previous?.turnId === params.turnId
      ? (params.previous.sourceProposedPlan ?? params.sourceProposedPlan)
      : params.sourceProposedPlan;
  return {
    turnId: params.turnId,
    state: params.state,
    requestedAt: params.requestedAt,
    startedAt: params.startedAt,
    completedAt: params.completedAt,
    assistantMessageId: params.assistantMessageId,
    ...(sourceProposedPlan ? { sourceProposedPlan } : {}),
  };
}

function reconcileLatestTurnFromSession(
  thread: Thread,
  session: NonNullable<ReadModelThread["session"]>,
  error: string | null,
): Thread["latestTurn"] {
  if (isSessionRunningTurn(session)) {
    return buildLatestTurn({
      previous: thread.latestTurn,
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
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  // Mirror of the server projector's settlement rule: once the session leaves
  // "running", no later event is guaranteed to close the turn (checkpoint diff
  // events only enrich it), so a still-running latestTurn settles here. A retained
  // activeTurnId blocks settlement (except on error): stop-requested flows emit
  // "interrupted" while keeping the turn active until the provider's terminal
  // event decides the real outcome.
  const settledState =
    session.status === "error"
      ? ("error" as const)
      : session.status === "interrupted" || session.status === "stopped"
        ? ("interrupted" as const)
        : session.status === "ready"
          ? ("completed" as const)
          : null;
  // A non-error session snapshot whose updatedAt predates the running turn's
  // start reflects the state from before that turn existed; settling on it
  // would close a just-started turn with a bogus fresh completedAt (and fire a
  // phantom completion notification). Errors still settle regardless: an error
  // snapshot is terminal whatever its ordering.
  if (
    settledState !== null &&
    thread.latestTurn?.state === "running" &&
    (session.activeTurnId == null || settledState === "error") &&
    (settledState === "error" ||
      session.updatedAt >= (thread.latestTurn.startedAt ?? thread.latestTurn.requestedAt))
  ) {
    return buildLatestTurn({
      previous: thread.latestTurn,
      turnId: thread.latestTurn.turnId,
      state: settledState,
      requestedAt: thread.latestTurn.requestedAt,
      startedAt: thread.latestTurn.startedAt,
      completedAt: session.updatedAt,
      assistantMessageId: thread.latestTurn.assistantMessageId,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  void error;
  return thread.latestTurn;
}

function rebindTurnDiffSummariesForAssistantMessage(
  turnDiffSummaries: ReadonlyArray<Thread["turnDiffSummaries"][number]>,
  turnId: Thread["turnDiffSummaries"][number]["turnId"],
  assistantMessageId: NonNullable<Thread["latestTurn"]>["assistantMessageId"],
): Thread["turnDiffSummaries"] {
  let changed = false;
  const nextSummaries = turnDiffSummaries.map((summary) => {
    if (summary.turnId !== turnId || summary.assistantMessageId === assistantMessageId) {
      return summary;
    }
    changed = true;
    return {
      ...summary,
      assistantMessageId: assistantMessageId ?? undefined,
    };
  });
  return changed ? nextSummaries : [...turnDiffSummaries];
}

function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<ChatMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ChatMessage[] {
  const retainedMessageIds = new Set<string>();
  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }
    if (
      message.turnId !== undefined &&
      message.turnId !== null &&
      retainedTurnIds.has(message.turnId)
    ) {
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
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
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
          (message.turnId === undefined ||
            message.turnId === null ||
            retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);
    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<Thread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["activities"] {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<Thread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): Thread["proposedPlans"] {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

function rollbackThreadMessagesFromMessage(
  messages: ReadonlyArray<ChatMessage>,
  messageId: string,
): {
  readonly messages: ChatMessage[];
  readonly removedTurnIds: ReadonlySet<string>;
} {
  const targetIndex = messages.findIndex((message) => message.id === messageId);
  if (targetIndex < 0) {
    return { messages: [...messages], removedTurnIds: new Set() };
  }

  const removedMessages = messages.slice(targetIndex);
  return {
    messages: messages.slice(0, targetIndex),
    removedTurnIds: new Set(
      removedMessages.flatMap((message) =>
        message.turnId === undefined || message.turnId === null ? [] : [message.turnId],
      ),
    ),
  };
}

function applyTurnDiffSummaryToThread(
  thread: Thread,
  summary: Thread["turnDiffSummaries"][number],
): Thread {
  const previousSummary = thread.turnDiffSummaries.find(
    (existingSummary) => existingSummary.turnId === summary.turnId,
  );
  const nextSummary = normalizeSingleTurnDiffSummary(summary, previousSummary);
  if (previousSummary && previousSummary.status !== "missing" && nextSummary.status === "missing") {
    return thread;
  }
  const turnDiffSummaries = previousSummary
    ? thread.turnDiffSummaries.map((existingSummary) =>
        existingSummary.turnId === nextSummary.turnId ? nextSummary : existingSummary,
      )
    : sortTurnDiffSummaries([...thread.turnDiffSummaries, nextSummary]);

  // Mirror of the server projector's placeholder guard: a provider-diff
  // placeholder only carries live diff totals and must never change the turn
  // lifecycle — neither close a running turn nor flip an already-settled one
  // to "interrupted" when it loses the race against session settlement.
  const isSameTurnPlaceholder =
    isProviderDiffPlaceholderRef(nextSummary.checkpointRef) &&
    nextSummary.status === "missing" &&
    thread.latestTurn?.turnId === nextSummary.turnId;
  const latestTurn =
    thread.latestTurn === null || thread.latestTurn.turnId === nextSummary.turnId
      ? isSameTurnPlaceholder
        ? thread.latestTurn
        : buildLatestTurn({
            previous: thread.latestTurn,
            turnId: nextSummary.turnId,
            state: checkpointStatusToLatestTurnState(nextSummary.status),
            requestedAt: thread.latestTurn?.requestedAt ?? nextSummary.completedAt,
            startedAt: thread.latestTurn?.startedAt ?? nextSummary.completedAt,
            completedAt: nextSummary.completedAt,
            // Prefer the incoming assistantMessageId when present; otherwise keep
            // the previous one from the same turn. Turn-diff events may arrive
            // before the message has been finalized and carry a null id — they
            // must not erase a real id already recorded by thread.message-sent.
            assistantMessageId:
              nextSummary.assistantMessageId ??
              (thread.latestTurn?.turnId === nextSummary.turnId
                ? thread.latestTurn.assistantMessageId
                : null) ??
              null,
            sourceProposedPlan: thread.pendingSourceProposedPlan,
          })
      : thread.latestTurn;

  if (
    previousSummary === nextSummary &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    (thread.updatedAt ?? thread.createdAt) >= nextSummary.completedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    turnDiffSummaries:
      arraysShallowEqual(thread.turnDiffSummaries, turnDiffSummaries) &&
      thread.turnDiffSummaries.length === turnDiffSummaries.length
        ? thread.turnDiffSummaries
        : turnDiffSummaries,
    latestTurn,
    updatedAt:
      (thread.updatedAt ?? thread.createdAt) > nextSummary.completedAt
        ? thread.updatedAt
        : nextSummary.completedAt,
  };
}

function mergeStreamingMessage(
  existingMessage: ChatMessage,
  incomingMessage: ChatMessage,
): ChatMessage | null {
  let nextText: string;
  if (
    existingMessage.role === "user" &&
    incomingMessage.role === "user" &&
    !incomingMessage.streaming
  ) {
    nextText = incomingMessage.text;
  } else if (incomingMessage.streaming || incomingMessage.text.length === 0) {
    nextText = `${existingMessage.text}${incomingMessage.text}`;
  } else if (incomingMessage.text.startsWith(existingMessage.text)) {
    nextText = incomingMessage.text;
  } else if (existingMessage.text.startsWith(incomingMessage.text)) {
    nextText = existingMessage.text;
  } else {
    nextText = `${existingMessage.text}${incomingMessage.text}`;
  }
  const nextAttachments = incomingMessage.attachments ?? existingMessage.attachments;
  const nextSkills =
    incomingMessage.skills && incomingMessage.skills.length > 0
      ? incomingMessage.skills
      : existingMessage.skills;
  const nextMentions =
    incomingMessage.mentions && incomingMessage.mentions.length > 0
      ? incomingMessage.mentions
      : existingMessage.mentions;
  const nextCompletedAt = incomingMessage.streaming
    ? existingMessage.completedAt
    : (incomingMessage.completedAt ?? existingMessage.completedAt);
  const nextTurnId =
    incomingMessage.turnId !== undefined ? incomingMessage.turnId : existingMessage.turnId;
  const nextDispatchMode =
    incomingMessage.dispatchMode !== undefined
      ? incomingMessage.dispatchMode
      : existingMessage.dispatchMode;
  const nextDispatchOrigin =
    incomingMessage.dispatchOrigin !== undefined
      ? incomingMessage.dispatchOrigin
      : existingMessage.dispatchOrigin;
  const nextSource = incomingMessage.source ?? existingMessage.source;

  if (
    existingMessage.text === nextText &&
    existingMessage.streaming === incomingMessage.streaming &&
    existingMessage.attachments === nextAttachments &&
    providerReferenceArraysEqual(existingMessage.skills, nextSkills) &&
    providerReferenceArraysEqual(existingMessage.mentions, nextMentions) &&
    existingMessage.completedAt === nextCompletedAt &&
    existingMessage.turnId === nextTurnId &&
    existingMessage.dispatchMode === nextDispatchMode &&
    existingMessage.dispatchOrigin === nextDispatchOrigin &&
    existingMessage.source === nextSource
  ) {
    return null;
  }

  return {
    ...existingMessage,
    text: nextText,
    streaming: incomingMessage.streaming,
    ...(nextAttachments ? { attachments: nextAttachments } : {}),
    ...(nextSkills && nextSkills.length > 0 ? { skills: [...nextSkills] } : {}),
    ...(nextMentions && nextMentions.length > 0 ? { mentions: [...nextMentions] } : {}),
    ...(nextTurnId !== undefined ? { turnId: nextTurnId } : {}),
    ...(nextDispatchMode !== undefined ? { dispatchMode: nextDispatchMode } : {}),
    ...(nextDispatchOrigin !== undefined ? { dispatchOrigin: nextDispatchOrigin } : {}),
    ...(nextSource !== undefined ? { source: nextSource } : {}),
    ...(nextCompletedAt !== undefined ? { completedAt: nextCompletedAt } : {}),
  };
}

function applyThreadMessageSentEvent(thread: Thread, event: ThreadMessageSentEvent): Thread {
  const payload = event.payload;
  // Single scan: the previous implementation ran `find` and `findIndex` with the same predicate
  // over the (up to MAX_THREAD_MESSAGES) message list for every streaming delta.
  const existingIndex = thread.messages.findIndex((message) => message.id === payload.messageId);
  const existingMessage = existingIndex >= 0 ? thread.messages[existingIndex] : undefined;
  const incomingMessage = normalizeChatMessage(
    {
      id: payload.messageId,
      role: payload.role,
      text: payload.text,
      dispatchMode: payload.dispatchMode,
      dispatchOrigin: payload.dispatchOrigin,
      turnId: payload.turnId,
      attachments: payload.attachments ?? [],
      ...(payload.skills !== undefined ? { skills: payload.skills } : {}),
      ...(payload.mentions !== undefined ? { mentions: payload.mentions } : {}),
      streaming: payload.streaming,
      source: payload.source,
      createdAt: payload.createdAt,
      updatedAt: payload.updatedAt,
    },
    existingMessage,
  );
  let messages = thread.messages;

  if (existingMessage) {
    const mergedMessage = mergeStreamingMessage(existingMessage, incomingMessage);
    if (mergedMessage !== null) {
      // Only the affected slot is replaced; every other message stays reference-identical.
      messages = thread.messages.with(existingIndex, mergedMessage);
    }
  } else {
    messages = [...thread.messages, incomingMessage].slice(-MAX_THREAD_MESSAGES);
  }

  const turnDiffSummaries =
    payload.role === "assistant" && payload.turnId !== null
      ? rebindTurnDiffSummariesForAssistantMessage(
          thread.turnDiffSummaries,
          payload.turnId,
          payload.messageId,
        )
      : thread.turnDiffSummaries;

  let latestTurn = thread.latestTurn;
  if (
    payload.role === "assistant" &&
    payload.turnId !== null &&
    (thread.latestTurn === null || thread.latestTurn.turnId === payload.turnId)
  ) {
    const previousTurn = thread.latestTurn;
    latestTurn = buildLatestTurn({
      previous: previousTurn,
      turnId: payload.turnId,
      state: payload.streaming
        ? "running"
        : previousTurn?.state === "interrupted"
          ? "interrupted"
          : previousTurn?.state === "error"
            ? "error"
            : "completed",
      requestedAt: previousTurn?.requestedAt ?? payload.createdAt,
      startedAt: previousTurn?.startedAt ?? payload.createdAt,
      completedAt: payload.streaming ? (previousTurn?.completedAt ?? null) : payload.updatedAt,
      assistantMessageId: payload.messageId,
      sourceProposedPlan: thread.pendingSourceProposedPlan,
    });
  }

  const updatedAt =
    thread.updatedAt && thread.updatedAt > payload.updatedAt ? thread.updatedAt : payload.updatedAt;
  if (
    messages === thread.messages &&
    turnDiffSummaries === thread.turnDiffSummaries &&
    latestTurn === thread.latestTurn &&
    updatedAt === thread.updatedAt
  ) {
    return thread;
  }

  return {
    ...thread,
    messages,
    turnDiffSummaries,
    latestTurn,
    updatedAt,
  };
}

function applyOrchestrationEvent(
  state: AppState,
  event: OrchestrationEvent,
  options?: ApplyOrchestrationEventOptions,
): AppState {
  switch (event.type) {
    case "space.created":
      return upsertSpace(state, {
        id: event.payload.spaceId,
        name: event.payload.name,
        icon: event.payload.icon,
        sortOrder: event.payload.sortOrder,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.updatedAt,
      });

    case "space.meta-updated": {
      const existing = state.spaces.find((space) => space.id === event.payload.spaceId);
      return existing
        ? upsertSpace(state, {
            ...existing,
            name: event.payload.name ?? existing.name,
            icon: event.payload.icon ?? existing.icon,
            updatedAt: event.payload.updatedAt,
          })
        : state;
    }

    case "space.order-updated":
      return applySpaceOrder(state, event.payload.orderedSpaceIds, event.payload.updatedAt);

    case "space.deleted":
      return removeSpace(state, event.payload.spaceId, event.payload.deletedAt);

    case "project.created":
      return upsertProject(
        state,
        {
          id: event.payload.projectId,
          kind: event.payload.kind,
          title: event.payload.title,
          workspaceRoot: event.payload.workspaceRoot,
          defaultModelSelection: event.payload.defaultModelSelection,
          scripts: event.payload.scripts,
          isPinned: event.payload.isPinned ?? false,
          spaceId: event.payload.spaceId ?? null,
          createdAt: event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        },
        "id-only",
      );

    case "project.meta-updated": {
      const existingProject = state.projects.find(
        (project) => project.id === event.payload.projectId,
      );
      if (!existingProject) {
        return state;
      }
      return upsertProject(
        state,
        {
          id: existingProject.id,
          kind: event.payload.kind ?? existingProject.kind,
          title: event.payload.title ?? existingProject.remoteName,
          workspaceRoot: event.payload.workspaceRoot ?? existingProject.cwd,
          defaultModelSelection:
            event.payload.defaultModelSelection !== undefined
              ? event.payload.defaultModelSelection
              : existingProject.defaultModelSelection,
          scripts: event.payload.scripts ?? existingProject.scripts,
          isPinned: event.payload.isPinned ?? existingProject.isPinned ?? false,
          spaceId:
            event.payload.spaceId !== undefined
              ? event.payload.spaceId
              : (existingProject.spaceId ?? null),
          createdAt: existingProject.createdAt ?? event.payload.updatedAt,
          updatedAt: event.payload.updatedAt,
        },
        "id-only",
      );
    }

    case "project.deleted": {
      return removeDeletedProjectFromClientState(state, event.payload.projectId, event.sequence);
    }

    case "thread.deleted":
      // Deletion is terminal for both active sidebar rows and archived settings rows.
      return removeDeletedThreadFromClientState(state, event.payload.threadId, event.sequence);

    case "thread.meta-updated":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          const nextBranch =
            event.payload.branch !== undefined
              ? resolveThreadBranchRegressionGuard({
                  currentBranch: thread.branch,
                  nextBranch: event.payload.branch,
                })
              : thread.branch;
          const nextWorktreePath =
            event.payload.worktreePath !== undefined
              ? event.payload.worktreePath
              : thread.worktreePath;
          const nextWorkingDirectory =
            event.payload.workingDirectory !== undefined
              ? event.payload.workingDirectory
              : (thread.workingDirectory ?? null);
          const nextAssociatedWorktreePath =
            event.payload.associatedWorktreePath !== undefined
              ? event.payload.associatedWorktreePath
              : (thread.associatedWorktreePath ?? null);
          const nextAssociatedWorktreeBranch =
            event.payload.associatedWorktreeBranch !== undefined
              ? event.payload.associatedWorktreeBranch
              : (thread.associatedWorktreeBranch ?? null);
          const nextAssociatedWorktreeRef =
            event.payload.associatedWorktreeRef !== undefined
              ? event.payload.associatedWorktreeRef
              : (thread.associatedWorktreeRef ?? null);
          const nextCreateBranchFlowCompleted = resolveCreateBranchFlowCompletedMerge({
            currentBranch: thread.branch,
            nextBranch,
            currentWorktreePath: thread.worktreePath,
            nextWorktreePath,
            currentAssociatedWorktreePath: thread.associatedWorktreePath,
            nextAssociatedWorktreePath,
            currentAssociatedWorktreeBranch: thread.associatedWorktreeBranch,
            nextAssociatedWorktreeBranch,
            currentAssociatedWorktreeRef: thread.associatedWorktreeRef,
            nextAssociatedWorktreeRef,
            currentCreateBranchFlowCompleted: thread.createBranchFlowCompleted,
            nextCreateBranchFlowCompleted: event.payload.createBranchFlowCompleted,
          });
          const nextUpdatedAt =
            (thread.updatedAt ?? thread.createdAt) > event.payload.updatedAt
              ? thread.updatedAt
              : event.payload.updatedAt;
          const cwdChanged =
            thread.worktreePath !== nextWorktreePath ||
            (thread.workingDirectory ?? null) !== nextWorkingDirectory;

          if (
            (event.payload.title === undefined || event.payload.title === thread.title) &&
            modelSelection === thread.modelSelection &&
            (event.payload.envMode === undefined || event.payload.envMode === thread.envMode) &&
            nextBranch === thread.branch &&
            nextWorktreePath === thread.worktreePath &&
            nextWorkingDirectory === (thread.workingDirectory ?? null) &&
            nextAssociatedWorktreePath === (thread.associatedWorktreePath ?? null) &&
            nextAssociatedWorktreeBranch === (thread.associatedWorktreeBranch ?? null) &&
            nextAssociatedWorktreeRef === (thread.associatedWorktreeRef ?? null) &&
            nextCreateBranchFlowCompleted === (thread.createBranchFlowCompleted ?? false) &&
            (event.payload.isPinned === undefined ||
              event.payload.isPinned === (thread.isPinned ?? false)) &&
            (event.payload.settledAt === undefined ||
              (event.payload.settledAt ?? null) === (thread.settledAt ?? null)) &&
            (event.payload.parentThreadId === undefined ||
              (event.payload.parentThreadId ?? null) === (thread.parentThreadId ?? null)) &&
            (event.payload.subagentAgentId === undefined ||
              (event.payload.subagentAgentId ?? null) === (thread.subagentAgentId ?? null)) &&
            (event.payload.subagentNickname === undefined ||
              (event.payload.subagentNickname ?? null) === (thread.subagentNickname ?? null)) &&
            (event.payload.subagentRole === undefined ||
              (event.payload.subagentRole ?? null) === (thread.subagentRole ?? null)) &&
            (event.payload.lastKnownPr === undefined ||
              deepEqualJson(event.payload.lastKnownPr ?? null, thread.lastKnownPr ?? null)) &&
            (event.payload.handoff === undefined ||
              (event.payload.handoff ?? null) === (thread.handoff ?? null)) &&
            (event.payload.pinnedMessages === undefined ||
              deepEqualJson(event.payload.pinnedMessages, thread.pinnedMessages ?? null)) &&
            (event.payload.threadMarkers === undefined ||
              deepEqualJson(event.payload.threadMarkers, thread.threadMarkers ?? null)) &&
            (event.payload.notes === undefined || event.payload.notes === (thread.notes ?? "")) &&
            nextUpdatedAt === thread.updatedAt
          ) {
            return thread;
          }

          return {
            ...thread,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            modelSelection,
            ...(event.payload.envMode !== undefined ? { envMode: event.payload.envMode } : {}),
            branch: nextBranch,
            worktreePath: nextWorktreePath,
            workingDirectory: nextWorkingDirectory,
            associatedWorktreePath: nextAssociatedWorktreePath,
            associatedWorktreeBranch: nextAssociatedWorktreeBranch,
            associatedWorktreeRef: nextAssociatedWorktreeRef,
            createBranchFlowCompleted: nextCreateBranchFlowCompleted,
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
              ? {
                  pinnedMessages: event.payload.pinnedMessages as NonNullable<
                    Thread["pinnedMessages"]
                  >,
                }
              : {}),
            ...(event.payload.threadMarkers !== undefined
              ? {
                  threadMarkers: event.payload.threadMarkers as NonNullable<
                    Thread["threadMarkers"]
                  >,
                }
              : {}),
            ...(event.payload.notes !== undefined ? { notes: event.payload.notes } : {}),
            updatedAt: nextUpdatedAt,
            ...(cwdChanged ? { session: null } : {}),
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.pinned-message-added":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = addPinnedMessage(thread.pinnedMessages, event.payload.pin);
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-removed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = removePinnedMessage(
            thread.pinnedMessages,
            event.payload.messageId,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-done-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = setPinnedMessageDone(
            thread.pinnedMessages,
            event.payload.messageId,
            event.payload.done,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.pinned-message-label-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pinnedMessages = setPinnedMessageLabel(
            thread.pinnedMessages,
            event.payload.messageId,
            event.payload.label,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.pinnedMessages === pinnedMessages && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            pinnedMessages,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.marker-added":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const threadMarkers = addThreadMarker(thread.threadMarkers, event.payload.marker);
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.threadMarkers === threadMarkers && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.marker-removed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const threadMarkers = removeThreadMarker(thread.threadMarkers, event.payload.markerId);
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.threadMarkers === threadMarkers && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.marker-done-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const threadMarkers = setThreadMarkerDone(
            thread.threadMarkers,
            event.payload.markerId,
            event.payload.done,
            event.payload.updatedAt,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.threadMarkers === threadMarkers && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.marker-label-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const threadMarkers = setThreadMarkerLabel(
            thread.threadMarkers,
            event.payload.markerId,
            event.payload.label,
            event.payload.updatedAt,
          );
          const updatedAt = resolveEventUpdatedAt(thread, event.payload.updatedAt);
          if (thread.threadMarkers === threadMarkers && thread.updatedAt === updatedAt) {
            return thread;
          }
          return {
            ...thread,
            threadMarkers,
            updatedAt,
          };
        },
        { ...options, updateSidebarSummary: false },
      );

    case "thread.message-sent":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => applyThreadMessageSentEvent(thread, event),
        {
          ...options,
          recomputeSummarySignals: threadMessageUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadMessageUpdatesSidebarSummary(event),
        },
      );

    case "thread.session-set":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const session = normalizeThreadSession(event.payload.session, thread.session);
          const error = normalizeThreadErrorMessage(event.payload.session.lastError);
          const latestTurn = reconcileLatestTurnFromSession(thread, event.payload.session, error);
          if (
            session === thread.session &&
            error === thread.error &&
            latestTurn === thread.latestTurn
          ) {
            return thread;
          }
          return {
            ...thread,
            session,
            error,
            latestTurn,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-interrupt-requested": {
      // Interrupt requests are best-effort and can fail or time out. Keep the
      // latest-turn clock/state live until the provider confirms a terminal event.
      return state;
    }

    case "thread.session-stop-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          if (thread.session === null) {
            return thread;
          }
          const latestTurn =
            thread.latestTurn !== null &&
            thread.latestTurn.state === "running" &&
            thread.latestTurn.completedAt === null
              ? buildLatestTurn({
                  previous: thread.latestTurn,
                  turnId: thread.latestTurn.turnId,
                  state: "interrupted",
                  requestedAt: thread.latestTurn.requestedAt,
                  startedAt: thread.latestTurn.startedAt ?? event.payload.createdAt,
                  completedAt: event.payload.createdAt,
                  assistantMessageId: thread.latestTurn.assistantMessageId,
                })
              : thread.latestTurn;
          return {
            ...thread,
            session: {
              ...thread.session,
              status: "closed",
              orchestrationStatus: "stopped",
              activeTurnId: undefined,
              updatedAt: event.payload.createdAt,
            },
            latestTurn,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-start-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const modelSelection =
            event.payload.modelSelection !== undefined
              ? normalizeModelSelection(event.payload.modelSelection, thread.modelSelection)
              : thread.modelSelection;
          // Automation-dispatched turns must not repaint the thread's persisted
          // modes (mirrors the server projection): the automation's modes govern
          // its own turn only, while the user's composer selection stays put.
          const adoptTurnModes = event.payload.dispatchOrigin !== "automation";
          const runtimeMode = adoptTurnModes ? event.payload.runtimeMode : thread.runtimeMode;
          const interactionMode = adoptTurnModes
            ? event.payload.interactionMode
            : thread.interactionMode;
          if (
            modelSelection === thread.modelSelection &&
            thread.runtimeMode === runtimeMode &&
            thread.interactionMode === interactionMode &&
            thread.pendingSourceProposedPlan === event.payload.sourceProposedPlan &&
            (thread.updatedAt ?? thread.createdAt) >= event.payload.createdAt
          ) {
            return thread;
          }
          return {
            ...thread,
            modelSelection,
            runtimeMode,
            interactionMode,
            pendingSourceProposedPlan: event.payload.sourceProposedPlan,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.user-input-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pendingInteractions = markInteractionResponding(thread, event);
          return {
            ...thread,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.approval-response-requested":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const pendingInteractions = markInteractionResponding(thread, event);
          return {
            ...thread,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.createdAt
                ? thread.updatedAt
                : event.payload.createdAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.activity-appended":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const sequencedActivity = withOrchestrationEventSequence(
            event.payload.activity,
            event.sequence,
          );
          const nextActivities = normalizeActivities(
            [...thread.activities, sequencedActivity],
            thread.activities,
          );
          const pendingInteractions = reconcilePendingInteractionsFromActivity(
            thread.id,
            thread.pendingInteractions,
            event,
          );
          if (
            nextActivities === thread.activities &&
            pendingInteractions === thread.pendingInteractions
          ) {
            return thread;
          }
          return {
            ...thread,
            activities: nextActivities,
            ...(pendingInteractions !== undefined ? { pendingInteractions } : {}),
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > sequencedActivity.createdAt
                ? thread.updatedAt
                : sequencedActivity.createdAt,
          };
        },
        {
          ...options,
          recomputeSummarySignals: threadActivityUpdatesSummary(event),
          updateSidebarSummary:
            options?.updateSidebarSummary === true || threadActivityUpdatesSummary(event),
        },
      );

    case "thread.proposed-plan-upserted":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const previousPlanIndex = thread.proposedPlans.findIndex(
            (plan) => plan.id === event.payload.proposedPlan.id,
          );
          const nextPlan = normalizeProposedPlans(
            [event.payload.proposedPlan],
            previousPlanIndex >= 0 ? [thread.proposedPlans[previousPlanIndex]!] : undefined,
          )[0];
          if (!nextPlan) {
            return thread;
          }
          const proposedPlans =
            previousPlanIndex >= 0
              ? thread.proposedPlans.map((plan, index) =>
                  index === previousPlanIndex ? nextPlan : plan,
                )
              : [...thread.proposedPlans, nextPlan];
          if (arraysShallowEqual(thread.proposedPlans, proposedPlans)) {
            return thread;
          }
          return {
            ...thread,
            proposedPlans,
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.payload.proposedPlan.updatedAt
                ? thread.updatedAt
                : event.payload.proposedPlan.updatedAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.turn-diff-completed":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) =>
          applyTurnDiffSummaryToThread(thread, {
            turnId: event.payload.turnId,
            completedAt: event.payload.completedAt,
            status: event.payload.status,
            files: event.payload.files.map((file) => ({
              path: file.path,
              ...(file.kind !== undefined ? { kind: file.kind } : {}),
              ...(file.additions !== undefined ? { additions: file.additions } : {}),
              ...(file.deletions !== undefined ? { deletions: file.deletions } : {}),
            })),
            checkpointRef: event.payload.checkpointRef,
            assistantMessageId: event.payload.assistantMessageId ?? undefined,
            checkpointTurnCount: event.payload.checkpointTurnCount,
          }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.reverted":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const turnDiffSummaries = thread.turnDiffSummaries
            .filter(
              (entry) =>
                entry.checkpointTurnCount !== undefined &&
                entry.checkpointTurnCount <= event.payload.turnCount,
            )
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            );
          const retainedTurnIds = new Set(turnDiffSummaries.map((entry) => entry.turnId));
          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            event.payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);
          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          );
          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages,
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.conversation-rolled-back":
      if (event.payload.numTurns === 0) {
        return state;
      }
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => {
          const rollback = rollbackThreadMessagesFromMessage(
            thread.messages,
            event.payload.messageId,
          );
          const removedTurnIds = new Set([
            ...rollback.removedTurnIds,
            ...(event.payload.removedTurnIds ?? []),
          ]);
          if (rollback.messages.length === thread.messages.length && removedTurnIds.size === 0) {
            return thread;
          }

          const turnDiffSummaries = thread.turnDiffSummaries
            .filter((entry) => !removedTurnIds.has(entry.turnId))
            .toSorted(
              (left, right) =>
                (left.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER) -
                (right.checkpointTurnCount ?? Number.MAX_SAFE_INTEGER),
            );
          const proposedPlans = thread.proposedPlans.filter(
            (plan) => plan.turnId === null || !removedTurnIds.has(plan.turnId),
          );
          const activities = thread.activities.filter(
            (activity) => activity.turnId === null || !removedTurnIds.has(activity.turnId),
          );
          const latestCheckpoint = turnDiffSummaries.at(-1) ?? null;

          return {
            ...thread,
            turnDiffSummaries,
            messages: rollback.messages.slice(-MAX_THREAD_MESSAGES),
            proposedPlans,
            activities,
            pendingSourceProposedPlan: undefined,
            latestTurn:
              latestCheckpoint === null
                ? null
                : {
                    turnId: latestCheckpoint.turnId,
                    state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                    requestedAt: latestCheckpoint.completedAt,
                    startedAt: latestCheckpoint.completedAt,
                    completedAt: latestCheckpoint.completedAt,
                    assistantMessageId: latestCheckpoint.assistantMessageId ?? null,
                  },
            updatedAt:
              (thread.updatedAt ?? thread.createdAt) > event.occurredAt
                ? thread.updatedAt
                : event.occurredAt,
          };
        },
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.archived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: event.payload.archivedAt ?? event.occurredAt,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    case "thread.unarchived":
      return applyThreadUpdate(
        state,
        event.payload.threadId,
        (thread) => ({
          ...thread,
          archivedAt: null,
          updatedAt: event.payload.updatedAt ?? event.occurredAt,
        }),
        {
          ...options,
          updateSidebarSummary: true,
        },
      );

    default:
      return state;
  }
}

function applyThreadActivityEventBatch(
  state: AppState,
  events: ReadonlyArray<ThreadActivityAppendedEvent>,
  options: ApplyOrchestrationEventOptions,
): AppState {
  const firstEvent = events[0];
  if (!firstEvent) {
    return state;
  }
  const updatesSummary = events.some(threadActivityUpdatesSummary);
  return applyThreadUpdate(
    state,
    firstEvent.payload.threadId,
    (thread) => {
      // One accumulator for the whole batch: appending N activities used to re-normalize the
      // full activity list N times (O(batch x activities)); it is now O(batch) amortised.
      const activityAccumulator = createThreadActivityAccumulator(thread.activities);
      let nextPendingInteractions = thread.pendingInteractions;
      let updatedAt = thread.updatedAt ?? thread.createdAt;
      for (const event of events) {
        const sequencedActivity = withOrchestrationEventSequence(
          event.payload.activity,
          event.sequence,
        );
        const activitiesChanged = activityAccumulator.append(sequencedActivity);
        const reconciledPendingInteractions = reconcilePendingInteractionsFromActivity(
          thread.id,
          nextPendingInteractions,
          event,
        );
        const changed =
          activitiesChanged || reconciledPendingInteractions !== nextPendingInteractions;
        nextPendingInteractions = reconciledPendingInteractions;
        if (changed && sequencedActivity.createdAt > updatedAt) {
          updatedAt = sequencedActivity.createdAt;
        }
      }
      const nextActivities = activityAccumulator.result();
      if (
        nextActivities === thread.activities &&
        nextPendingInteractions === thread.pendingInteractions
      ) {
        return thread;
      }
      return {
        ...thread,
        activities: nextActivities,
        ...(nextPendingInteractions !== undefined
          ? { pendingInteractions: nextPendingInteractions }
          : {}),
        updatedAt,
      };
    },
    {
      ...options,
      recomputeSummarySignals: updatesSummary,
      updateSidebarSummary: options.updateSidebarSummary === true || updatesSummary,
    },
  );
}

export function applyOrchestrationEvents(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
): AppState {
  return applyOrchestrationEventsHotPath(state, events, {
    updateSidebarSummary: false,
  });
}

export function applyOrchestrationEventsHotPath(
  state: AppState,
  events: ReadonlyArray<OrchestrationEvent>,
  options?: ApplyOrchestrationEventOptions,
): AppState {
  const normalizedOptions = {
    updateSidebarSummary: options?.updateSidebarSummary ?? false,
  };
  let nextState = state;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]!;
    if (event.type === "thread.activity-appended") {
      const activityEvents = [event];
      while (index + 1 < events.length) {
        const nextEvent = events[index + 1];
        if (
          nextEvent?.type !== "thread.activity-appended" ||
          nextEvent.payload.threadId !== event.payload.threadId
        ) {
          break;
        }
        activityEvents.push(nextEvent);
        index += 1;
      }
      nextState = applyThreadActivityEventBatch(nextState, activityEvents, normalizedOptions);
      continue;
    }
    nextState = applyOrchestrationEvent(nextState, event, normalizedOptions);
  }
  return nextState;
}
