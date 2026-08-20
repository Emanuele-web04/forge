// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests with the running-chats confirmation.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC and the orchestration store.

import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  listRunningChatsFromDesktopStore,
  stopRunningChatsForQuit,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

import { RunningChatsQuitDialog } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const [chats, setChats] = useState<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  const pendingRequestIdRef = useRef<string | null>(null);

  const settle = useCallback(
    (allow: boolean) => {
      const requestId = pendingRequestIdRef.current;
      if (!requestId) {
        return;
      }
      const chatsToStop = allow ? chats : null;
      pendingRequestIdRef.current = null;
      setChats(null);

      const reply = (allowQuit: boolean) => {
        window.desktopBridge?.replyQuitConfirmation({
          requestId,
          phase: "decision",
          allow: allowQuit,
        });
      };

      if (!allow || chatsToStop == null || chatsToStop.length === 0) {
        reply(allow);
        return;
      }

      // Stop in the background so the window can close immediately.
      void stopRunningChatsForQuit({
        chats: chatsToStop,
        dispatchInterrupt: (threadId) => {
          const api = readNativeApi();
          if (!api) {
            return;
          }
          return api.orchestration.dispatchCommand({
            type: "thread.turn.interrupt",
            commandId: newCommandId(),
            threadId: ThreadId.makeUnsafe(threadId),
            createdAt: new Date().toISOString(),
          });
        },
      });
      reply(true);
    },
    [chats],
  );

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
    <RunningChatsQuitDialog
      chats={chats}
      onStay={() => settle(false)}
      onQuit={() => settle(true)}
    />
  );
}
