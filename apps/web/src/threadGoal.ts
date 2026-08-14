import { type ThreadId } from "@synara/contracts";

import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";

export async function dispatchThreadGoal(threadId: ThreadId, goal: string): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Synara API is unavailable.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    goal,
  });
}

export async function dispatchThreadGoalPaused(threadId: ThreadId, paused: boolean): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Synara API is unavailable.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    goalPaused: paused,
  });
}
