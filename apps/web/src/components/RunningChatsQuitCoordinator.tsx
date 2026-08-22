// FILE: RunningChatsQuitCoordinator.tsx
// Purpose: Answers Electron quit requests with the running-chats confirmation.
// Layer: Root web coordinator
// Depends on: Desktop bridge quit IPC, the orchestration store, and the quit-resume RPC.

import { ThreadId } from "@synara/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import {
  listRunningChatsFromDesktopStore,
  quitResumeContinuationPrompt,
  stopRunningChatsForQuit,
  type RunningChatQuitSummary,
} from "~/lib/runningChatsQuitConfirmation";
import { newCommandId } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import { useStore } from "~/store";

import { RunningChatsQuitDialog, type RunningChatsQuitDecision } from "./RunningChatsQuitDialog";

export function RunningChatsQuitCoordinator() {
  const [chats, setChats] = useState<ReadonlyArray<RunningChatQuitSummary> | null>(null);
  // True while the resume record is being written: the dialog stays up (inert) so the
  // user does not see a bare window for the bounded wait before the desktop hides it.
  const [quitting, setQuitting] = useState(false);
  const pendingRequestIdRef = useRef<string | null>(null);

  const settle = useCallback(
    (decision: RunningChatsQuitDecision | null) => {
      const requestId = pendingRequestIdRef.current;
      if (!requestId) {
        return;
      }
      const allow = decision != null;
      const chatsToStop = allow ? chats : null;
      pendingRequestIdRef.current = null;
      if (!decision?.resume) {
        setChats(null);
      }

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

      const stopped = stopRunningChatsForQuit({
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
        ...(decision.resume
          ? {
              resume: {
                prepare: (threadIds: ReadonlyArray<string>) => {
                  const api = readNativeApi();
                  if (!api) {
                    return Promise.reject(new Error("Native API unavailable"));
                  }
                  return api.orchestration.prepareQuitResume({
                    threadIds: threadIds.map((threadId) => ThreadId.makeUnsafe(threadId)),
                    continuationPrompt: quitResumeContinuationPrompt(APP_DISPLAY_NAME),
                  });
                },
              },
            }
          : {}),
      });

      if (decision.resume) {
        // The resume record must be durable before the desktop is allowed to stop the
        // backend; the wait is bounded so quit stays snappy even if the server is slow.
        setQuitting(true);
        void stopped.finally(() => {
          reply(true);
          setQuitting(false);
          setChats(null);
        });
        return;
      }
      // Interrupt in the background so the window can close immediately.
      void stopped;
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
      quitting={quitting}
      onStay={() => settle(null)}
      onQuit={settle}
    />
  );
}
