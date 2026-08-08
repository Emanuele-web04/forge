// FILE: terminalSession.ts
// Purpose: Shared terminal-teardown routine reused by every terminal surface
//          (chat drawer and right-dock pane): dispose + server-close with a
//          fallback, a sequence that was duplicated verbatim.
// Layer: Web terminal runtime helpers
// Depends on: terminalRuntimeRegistry (xterm instances, loaded on demand),
//             NativeApi terminal channel.
// Note: the id factory lives in `terminalIds.ts` so eager consumers can import
//       it without anchoring xterm into the initial bundle.

import { type NativeApi } from "@synara/contracts";

// The terminal runtime pulls in xterm and its addons (~223 KB gzip). Importing
// the registry statically anchored the whole terminal stack into the eager
// router graph via this module's callers, so every page load paid for it.
// Closing a terminal is a rare user action and the chunk is already resident
// whenever a terminal is actually on screen, so this resolves from the module
// cache in practice.
async function disposeTerminalRuntime(threadId: string, terminalId: string): Promise<void> {
  try {
    const { terminalRuntimeRegistry } = await import("./terminalRuntimeRegistry");
    terminalRuntimeRegistry.disposeTerminal(threadId, terminalId);
  } catch (error) {
    // A failed chunk fetch must not strand the server-side terminal: fall
    // through to the close call below, which is the half that actually frees
    // the PTY and its history.
    console.error("Failed to dispose terminal runtime", { threadId, terminalId, error });
  }
}

// Tear down a terminal everywhere it lives: drop the local xterm instance, then
// ask the server to close it (deleting history) with a best-effort `exit` write
// fallback for transports that lack a structured close. `clearHistoryBeforeClose`
// mirrors the chat surface's behavior when closing the final terminal of a thread.
export function disposeAndCloseTerminalSession(input: {
  api: NativeApi | undefined;
  threadId: string;
  terminalId: string;
  clearHistoryBeforeClose?: boolean;
  processAlreadyExited?: boolean;
}): void {
  const { api, threadId, terminalId } = input;

  const fallbackExitWrite = () => {
    if (input.processAlreadyExited) {
      return Promise.resolve();
    }
    return api?.terminal.write({ threadId, terminalId, data: "exit\n" }).catch(() => undefined);
  };

  // Local disposal stays ordered before the server close, as it was when the
  // registry was imported statically.
  void (async () => {
    await disposeTerminalRuntime(threadId, terminalId);

    if (api && "close" in api.terminal && typeof api.terminal.close === "function") {
      try {
        if (input.clearHistoryBeforeClose) {
          await api.terminal.clear({ threadId, terminalId }).catch(() => undefined);
        }
        await api.terminal.close({ threadId, terminalId, deleteHistory: true });
      } catch {
        await fallbackExitWrite();
      }
      return;
    }

    await fallbackExitWrite();
  })();
}
