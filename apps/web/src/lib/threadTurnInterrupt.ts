// FILE: threadTurnInterrupt.ts
// Purpose: The one way a surface asks the server to stop a thread's current turn.
// Layer: Web command helper
// Exports: interruptThreadTurn
//
// Stopping a turn is also how the desktop is handed back: `ComputerManager`
// releases the exclusive lease the moment the owning thread stops being able to
// drive, which is turn end. So the Computer pane's "Stop the agent" is this and
// not a computer-specific kill path — a second mechanism could stop the desktop
// while the turn kept running, or the reverse, and the user would have no way to
// tell which one they had pressed.

import type { ThreadId } from "@synara/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { newCommandId } from "./utils";

export async function interruptThreadTurn(threadId: ThreadId): Promise<void> {
  const api = ensureNativeApi();
  await api.orchestration.dispatchCommand({
    type: "thread.turn.interrupt",
    commandId: newCommandId(),
    threadId,
    createdAt: new Date().toISOString(),
  });
}
