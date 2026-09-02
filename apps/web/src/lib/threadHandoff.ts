// FILE: threadHandoff.ts
// Purpose: Builds client-side handoff commands and imported transcript payloads.
// Layer: Web handoff utilities
// Exports: target-provider, title, transcript, and model-selection helpers.

import {
  EventId,
  MessageId,
  type OrchestrationThreadActivity,
  PROVIDER_DISPLAY_NAMES,
  type ModelSelection,
  type ProviderKind,
  type ServerProviderStatus,
  type ServerSettingsView,
  type ThreadHandoffImportedMessage,
} from "@synara/contracts";
import { getDefaultModel } from "@synara/shared/model";
import { type Thread } from "../types";
import { DEFAULT_PROVIDER_ORDER } from "../providerOrdering";
import { stripEmbeddedAssistantSelections } from "./assistantSelections";
import { extractTrailingBrowserAnnotations } from "./browserAnnotations";
import { isCompletedContextCompaction } from "./contextWindow";
import { findProviderStatus, isProviderUsable } from "./providerAvailability";
import { randomUUID } from "./utils";

const IMPORTABLE_THREAD_ACTIVITY_KINDS = new Set([
  "account.rate-limits.updated",
  "account.rate-limited",
  "context-compaction",
  "context-window.updated",
]);

function isImportableThreadMessage(
  message: Thread["messages"][number],
): message is Thread["messages"][number] & {
  role: "user" | "assistant";
} {
  return (message.role === "user" || message.role === "assistant") && message.streaming === false;
}

function isImportableThreadActivity(
  activity: Thread["activities"][number],
): activity is OrchestrationThreadActivity {
  return IMPORTABLE_THREAD_ACTIVITY_KINDS.has(activity.kind);
}

export function isEligibleHandoffTargetProvider(input: {
  readonly sourceProvider: ProviderKind;
  readonly targetProvider: ProviderKind;
  readonly targetProviderEnabled: boolean | null | undefined;
  readonly targetProviderStatus: ServerProviderStatus | null | undefined;
}): boolean {
  return (
    input.targetProvider !== input.sourceProvider &&
    input.targetProviderEnabled === true &&
    input.targetProviderStatus?.provider === input.targetProvider &&
    isProviderUsable(input.targetProviderStatus)
  );
}

export function resolveAvailableHandoffTargetProviders(input: {
  readonly sourceProvider: ProviderKind;
  readonly providerSettings: ServerSettingsView["providers"] | null | undefined;
  readonly providerStatuses: readonly ServerProviderStatus[];
}): ReadonlyArray<ProviderKind> {
  return DEFAULT_PROVIDER_ORDER.filter((targetProvider) =>
    isEligibleHandoffTargetProvider({
      sourceProvider: input.sourceProvider,
      targetProvider,
      targetProviderEnabled: input.providerSettings?.[targetProvider].enabled,
      targetProviderStatus: findProviderStatus(input.providerStatuses, targetProvider),
    }),
  );
}

export function resolveThreadHandoffBadgeLabel(thread: Pick<Thread, "handoff">): string | null {
  if (!thread.handoff) {
    return null;
  }
  return `Handoff from ${PROVIDER_DISPLAY_NAMES[thread.handoff.sourceProvider]}`;
}

// Preserve the visible source thread name when creating the destination thread.
export function resolveThreadHandoffTitle(thread: Pick<Thread, "title">): string {
  const title = thread.title.trim().replace(/\s+/g, " ");
  return title.length > 0 ? title : "Handoff";
}

export function buildThreadHandoffImportedMessages(
  thread: Pick<Thread, "messages">,
  // Forking from a message footer carries only the transcript up to that turn, so
  // the new thread starts exactly where the user clicked. Omitted = whole thread.
  options?: { readonly throughMessageId?: MessageId | null },
): ReadonlyArray<ThreadHandoffImportedMessage> {
  const importable = thread.messages.filter(isImportableThreadMessage);
  const cutoffId = options?.throughMessageId ?? null;
  const cutoffIndex = cutoffId ? importable.findIndex((message) => message.id === cutoffId) : -1;
  const scopedMessages = cutoffIndex >= 0 ? importable.slice(0, cutoffIndex + 1) : importable;
  return scopedMessages.map((message) => {
    const importedMessageId = MessageId.makeUnsafe(randomUUID());
    let importedText = message.text;
    if (message.role === "user") {
      const extractedBrowserAnnotations = extractTrailingBrowserAnnotations(
        message.text,
        message.id,
      );
      const visibleAndContextText = stripEmbeddedAssistantSelections(
        extractedBrowserAnnotations.promptText,
      );
      // Browser annotation ids and tab ids are scoped to the source thread's
      // live browser session. Carrying them into a handoff would advertise an
      // exact-page navigation target that the destination thread cannot
      // resolve, so import only the visible user/context text.
      importedText = visibleAndContextText;
    }
    const importedMessage: ThreadHandoffImportedMessage = {
      messageId: importedMessageId,
      role: message.role,
      text: importedText,
      createdAt: message.createdAt,
      updatedAt: message.completedAt ?? message.createdAt,
    };
    const attachments =
      message.attachments && message.attachments.length > 0
        ? message.attachments.map((attachment) =>
            attachment.type === "assistant-selection"
              ? {
                  type: attachment.type,
                  id: attachment.id,
                  assistantMessageId: attachment.assistantMessageId,
                  text: attachment.text,
                }
              : {
                  type: attachment.type,
                  id: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                },
          )
        : null;
    return attachments ? Object.assign(importedMessage, { attachments }) : importedMessage;
  });
}

export function buildThreadHandoffImportedActivities(
  thread: Pick<Thread, "activities">,
): ReadonlyArray<OrchestrationThreadActivity> {
  // Activity appends are not transactional. Start context history at the latest
  // durable boundary so a partial handoff can never persist already-invalid usage.
  let latestCompactionIndex = -1;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index];
    if (activity && isCompletedContextCompaction(activity)) {
      latestCompactionIndex = index;
      break;
    }
  }

  return thread.activities
    .filter(
      (activity, index) =>
        isImportableThreadActivity(activity) &&
        (latestCompactionIndex < 0 ||
          (activity.kind !== "context-window.updated" && activity.kind !== "context-compaction") ||
          index >= latestCompactionIndex),
    )
    .map((activity) => {
      const { sequence: _sequence, ...rest } = activity;
      return {
        ...rest,
        id: EventId.makeUnsafe(randomUUID()),
      };
    });
}

export function hasNativeThreadHandoffMessages(thread: Pick<Thread, "messages">): boolean {
  return thread.messages.some(
    (message) => isImportableThreadMessage(message) && message.source === "native",
  );
}

export function canCreateThreadHandoff(input: {
  readonly thread: Pick<Thread, "handoff" | "messages" | "session">;
  readonly isBusy?: boolean;
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
}): boolean {
  if (input.isBusy || input.hasPendingApprovals || input.hasPendingUserInput) {
    return false;
  }
  const sessionStatus = input.thread.session?.orchestrationStatus;
  if (sessionStatus === "starting" || sessionStatus === "running") {
    return false;
  }
  const importedMessages = buildThreadHandoffImportedMessages(input.thread);
  if (importedMessages.length === 0) {
    return false;
  }
  if (input.thread.handoff !== null) {
    return hasNativeThreadHandoffMessages(input.thread);
  }
  return true;
}

export function resolveThreadHandoffModelSelection(input: {
  readonly sourceThread: Pick<Thread, "modelSelection">;
  readonly targetProvider: ProviderKind;
  readonly projectDefaultModelSelection: ModelSelection | null | undefined;
  readonly stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>;
}): ModelSelection {
  const isCompatibleSelection = (
    selection: ModelSelection | null | undefined,
  ): selection is ModelSelection => {
    return Boolean(selection && selection.provider === input.targetProvider);
  };

  const stickySelection = input.stickyModelSelectionByProvider[input.targetProvider];
  if (isCompatibleSelection(stickySelection)) {
    return stickySelection;
  }
  if (isCompatibleSelection(input.projectDefaultModelSelection)) {
    return input.projectDefaultModelSelection;
  }
  const defaultModel = getDefaultModel(input.targetProvider);
  if (!defaultModel) {
    throw new Error("Select a Pi model before handing off to Pi.");
  }
  return {
    provider: input.targetProvider,
    model: defaultModel,
  };
}
