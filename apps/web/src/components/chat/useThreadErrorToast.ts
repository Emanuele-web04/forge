// FILE: useThreadErrorToast.ts
// Purpose: Surfaces thread-level runtime errors as a floating error toast.
// Layer: Chat status presentation
// Exports: useThreadErrorToast, buildThreadErrorToastOptions, threadErrorToastId

import type { ThreadId } from "@synara/contracts";
import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { useEffect, useRef, type RefObject } from "react";

import { toastManager } from "../ui/toast";

type ThreadErrorToastOptions = Parameters<typeof toastManager.add>[0];

/** One toast per thread: re-adding under the same id updates the card in place
 *  instead of stacking a new toast for every error update. */
export function threadErrorToastId(threadId: ThreadId): string {
  return `thread-error:${threadId}`;
}

export function buildThreadErrorToastOptions(input: {
  error: string;
  onClose: () => void;
  onUnblock: () => void;
  threadId: ThreadId;
  unblocking: boolean;
}): ThreadErrorToastOptions {
  const canUnblock = isProviderDeliveryBlockDetail(input.error);
  return {
    id: threadErrorToastId(input.threadId),
    type: "error",
    title: input.error,
    timeout: 0,
    priority: "high",
    onClose: input.onClose,
    data: { copyText: input.error, threadId: input.threadId },
    ...(canUnblock
      ? {
          actionProps: {
            children: input.unblocking ? "Unblocking…" : "Unblock thread",
            disabled: input.unblocking,
            onClick: input.onUnblock,
          },
        }
      : {}),
  };
}

/** Closing the toast on our own behalf (error cleared, thread switched, unmount)
 *  must not report a user dismissal, which would clear thread state we still need. */
function closeSilently(threadId: ThreadId, silentRef: RefObject<boolean>): void {
  silentRef.current = true;
  toastManager.close(threadErrorToastId(threadId));
  silentRef.current = false;
}

/**
 * Mirrors the thread-level error of `threadId` into a floating toast. Errors used
 * to render as an inline banner above the transcript, which pushed the whole chat
 * column down every time a provider failed; the toast keeps the layout stable.
 */
export function useThreadErrorToast(input: {
  error: string | null;
  onDismiss: () => void;
  onUnblock: () => void;
  threadId: ThreadId | null;
  unblocking: boolean;
}): void {
  const { error, onDismiss, onUnblock, threadId, unblocking } = input;
  const callbacksRef = useRef({ onDismiss, onUnblock });
  const closingSilentlyRef = useRef(false);

  useEffect(() => {
    callbacksRef.current = { onDismiss, onUnblock };
  }, [onDismiss, onUnblock]);

  useEffect(() => {
    if (!threadId) return;
    if (!error) {
      closeSilently(threadId, closingSilentlyRef);
      return;
    }
    toastManager.add(
      buildThreadErrorToastOptions({
        error,
        threadId,
        unblocking,
        onClose: () => {
          if (closingSilentlyRef.current) return;
          callbacksRef.current.onDismiss();
        },
        onUnblock: () => {
          callbacksRef.current.onUnblock();
        },
      }),
    );
  }, [error, threadId, unblocking]);

  // Kept separate from the content effect so an error update refreshes the card in
  // place instead of tearing it down and replaying the entrance animation.
  useEffect(() => {
    if (!threadId) return;
    return () => {
      closeSilently(threadId, closingSilentlyRef);
    };
  }, [threadId]);
}
