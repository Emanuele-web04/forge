// FILE: useThreadUnblock.ts
// Purpose: Drives the "Unblock thread" recovery action for provider-delivery quarantines.
// Layer: Web chat recovery hook
// Exports: useThreadUnblock

import type { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { toastManager } from "../components/ui/toast";
import { describeThreadUnblockResult, unblockThreadFromClient } from "../lib/threadUnblock";
import { readNativeApi } from "../nativeApi";

/**
 * Reconciles the blocking deliveries of `threadId` and reports the outcome.
 * `onUnblocked` clears the thread-level error the quarantine left behind: the
 * server only republishes a session update when a skipped command is replayed,
 * so the banner would otherwise linger after a no-op recovery.
 */
export function useThreadUnblock(input: {
  readonly threadId: ThreadId | null;
  readonly onUnblocked: (threadId: ThreadId) => void;
}): { readonly unblockThread: () => void; readonly unblocking: boolean } {
  const { threadId, onUnblocked } = input;
  const [unblockingThreadId, setUnblockingThreadId] = useState<ThreadId | null>(null);
  const inFlightThreadIdRef = useRef<ThreadId | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const unblockThread = useCallback(() => {
    if (!threadId || inFlightThreadIdRef.current !== null) return;
    inFlightThreadIdRef.current = threadId;
    setUnblockingThreadId(threadId);
    void (async () => {
      try {
        const api = readNativeApi();
        if (!api) throw new Error("Not connected to the Synara server.");
        const result = await unblockThreadFromClient(api.orchestration, threadId);
        onUnblocked(threadId);
        toastManager.add(describeThreadUnblockResult(result));
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not unblock thread",
          description:
            error instanceof Error
              ? error.message
              : "An unexpected error occurred while clearing the provider failure.",
        });
      } finally {
        inFlightThreadIdRef.current = null;
        if (mountedRef.current) setUnblockingThreadId(null);
      }
    })();
  }, [onUnblocked, threadId]);

  return {
    unblockThread,
    unblocking: threadId !== null && unblockingThreadId === threadId,
  };
}
