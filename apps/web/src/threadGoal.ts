import { type ThreadGoalStartBehavior, type ThreadId } from "@synara/contracts";

import { newCommandId } from "./lib/utils";
import { readNativeApi } from "./nativeApi";

export async function dispatchThreadGoal(
  threadId: ThreadId,
  goal: string,
  options: { readonly startBehavior?: ThreadGoalStartBehavior } = {},
): Promise<void> {
  const api = readNativeApi();
  if (!api) {
    throw new Error("Synara API is unavailable.");
  }
  await api.orchestration.dispatchCommand({
    type: "thread.meta.update",
    commandId: newCommandId(),
    threadId,
    goal,
    ...(options.startBehavior !== undefined ? { goalStartBehavior: options.startBehavior } : {}),
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
