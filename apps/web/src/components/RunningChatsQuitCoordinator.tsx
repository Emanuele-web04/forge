// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests with the running-chats confirmation.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC and the orchestration store.

import { useCallback, useEffect, useRef, useState } from "react";

import {
  listRunningChatsFromDesktopStore,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { useStore } from "~/store";

import { RunningChatsQuitDialog } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const [chats, setChats] = useState<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);

  const settle = useCallback((allow: boolean) => {
    const requestId = pendingRequestIdRef.current;
    if (!requestId) {
      return;
    }
    pendingRequestIdRef.current = null;
    setChats(null);
    window.desktopBridge?.replyQuitConfirmation({
      requestId,
      phase: "decision",
      allow,
    });
  }, []);

  useEffect(() => {
    const subscribe = window.desktopBridge?.onQuitConfirmationRequest;
    const reply = window.desktopBridge?.replyQuitConfirmation;
    if (typeof subscribe !== "function" || typeof reply !== "function") {
      return;
    }

    return subscribe((request) => {
      const running = listRunningChatsFromDesktopStore(useStore.getState());
      if (running.length === 0) {
        reply({ requestId: request.requestId, phase: "decision", allow: true });
        return;
      }

      reply({
        requestId: request.requestId,
        phase: "ready",
        runningCount: running.length,
        chats: running,
      });
      pendingRequestIdRef.current = request.requestId;
      setChats(running);
    });
  }, []);

  return (
    <RunningChatsQuitDialog chats={chats} onStay={() => settle(false)} onQuit={() => settle(true)} />
  );
}
