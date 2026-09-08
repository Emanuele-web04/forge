// FILE: pinnedMessages.ts
// Purpose: Pure transforms + dispatch helpers for per-thread pinned messages and notes.
// Layer: Chat environment panel + message timeline helpers.

import {
  PINNED_MESSAGE_LABEL_MAX_CHARS,
  type MessageId,
  type PinnedMessage,
  type ThreadId,
} from "@synara/contracts";
import {
  addPinnedMessage,
  clampThreadNotes,
  isMessagePinned,
  normalizePinLabel,
  removePinnedMessage,
  setPinnedMessageDone,
  setPinnedMessageLabel,
  togglePinnedMessageDone,
} from "@synara/shared/pinnedMessages";

import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";

// Strip the most common leading block markers (headings, list bullets, blockquotes)
// and inline emphasis so an auto-derived label reads as plain prose.
const LEADING_BLOCK_MARKER_PATTERN = /^\s*(?:#{1,6}\s+|>+\s*|[-*+]\s+|\d+[.)]\s+)/;
const INLINE_EMPHASIS_PATTERN = /[*_`~]+/g;

/**
 * Derive a human-readable label from a pinned message's text: the first non-empty
 * line, lightly de-marked and truncated. Returns "" when there is no usable text.
 */
export function derivePinLabel(messageText: string): string {
  const normalized = messageText.replace(/\r\n/g, "\n");
  let firstLine = "";
  for (const rawLine of normalized.split("\n")) {
    const candidate = rawLine.replace(LEADING_BLOCK_MARKER_PATTERN, "").trim();
    if (candidate.length > 0) {
      firstLine = candidate;
      break;
    }
  }
  if (firstLine.length === 0) {
    return "";
  }
  const cleaned = firstLine.replace(INLINE_EMPHASIS_PATTERN, "").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return "";
  }
  return cleaned.length > PINNED_MESSAGE_LABEL_MAX_CHARS
    ? `${cleaned.slice(0, PINNED_MESSAGE_LABEL_MAX_CHARS - 1)}…`
    : cleaned;
}

/**
 * Resolve the label to render for a pin: an explicit user override wins, otherwise
 * the auto-derived label from the message text. Returns "" when the message text is
 * unavailable and there is no override (callers render their own fallback).
 */
export function displayLabelFor(pin: PinnedMessage, messageText: string | undefined): string {
  const override = pin.label?.trim();
  if (override) {
    return override;
  }
  return messageText === undefined ? "" : derivePinLabel(messageText);
}

export { clampThreadNotes, isMessagePinned, normalizePinLabel };

export function addPin(
  pins: readonly PinnedMessage[] | undefined,
  messageId: MessageId,
  pinnedAt: string,
): PinnedMessage[] {
  return addPinnedMessage(pins, { messageId, label: null, done: false, pinnedAt });
}

export function removePin(
  pins: readonly PinnedMessage[] | undefined,
  messageId: MessageId,
): PinnedMessage[] {
  return removePinnedMessage(pins, messageId);
}

export function restorePinAtIndex(
  pins: readonly PinnedMessage[] | undefined,
  pin: PinnedMessage,
  index: number,
): PinnedMessage[] {
  const existingPins = pins ?? [];
  if (isMessagePinned(existingPins, pin.messageId)) {
    return existingPins as PinnedMessage[];
  }
  const nextPins = [...existingPins];
  nextPins.splice(Math.max(0, Math.min(index, nextPins.length)), 0, pin);
  return nextPins;
}

export function togglePinDone(
  pins: readonly PinnedMessage[] | undefined,
  messageId: MessageId,
): PinnedMessage[] {
  return togglePinnedMessageDone(pins, messageId);
}

export function setPinDone(
  pins: readonly PinnedMessage[] | undefined,
  messageId: MessageId,
  done: boolean,
): PinnedMessage[] {
  return setPinnedMessageDone(pins, messageId, done);
}

/** Set (or clear, with `null`) a pin's user-provided label. Empty input clears it. */
export function setPinLabel(
  pins: readonly PinnedMessage[] | undefined,
  messageId: MessageId,
  label: string | null,
): PinnedMessage[] {
  return setPinnedMessageLabel(pins, messageId, label);
}

async function dispatchSidepanelCommand(
  command:
    | {
        readonly type: "thread.pinned-message.add" | "thread.pinned-message.remove";
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
      }
    | {
        readonly type: "thread.pinned-message.done.set";
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly done: boolean;
      }
    | {
        readonly type: "thread.pinned-message.label.set";
        readonly threadId: ThreadId;
        readonly messageId: MessageId;
        readonly label: string | null;
      }
    | {
        readonly type: "thread.meta.update";
        readonly threadId: ThreadId;
        readonly notes: string;
      },
): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    return;
  }
  await api.orchestration.dispatchCommand({
    commandId: newCommandId(),
    ...command,
  });
}

export function dispatchPinnedMessageAdd(threadId: ThreadId, messageId: MessageId): Promise<void> {
  return dispatchSidepanelCommand({ type: "thread.pinned-message.add", threadId, messageId });
}

export function dispatchPinnedMessageRemove(
  threadId: ThreadId,
  messageId: MessageId,
): Promise<void> {
  return dispatchSidepanelCommand({ type: "thread.pinned-message.remove", threadId, messageId });
}

export function dispatchPinnedMessageDoneSet(
  threadId: ThreadId,
  messageId: MessageId,
  done: boolean,
): Promise<void> {
  return dispatchSidepanelCommand({
    type: "thread.pinned-message.done.set",
    threadId,
    messageId,
    done,
  });
}

export function dispatchPinnedMessageLabelSet(
  threadId: ThreadId,
  messageId: MessageId,
  label: string | null,
): Promise<void> {
  return dispatchSidepanelCommand({
    type: "thread.pinned-message.label.set",
    threadId,
    messageId,
    label: normalizePinLabel(label),
  });
}

export function dispatchThreadNotes(threadId: ThreadId, notes: string): Promise<void> {
  return dispatchSidepanelCommand({
    type: "thread.meta.update",
    threadId,
    notes: clampThreadNotes(notes),
  });
}
