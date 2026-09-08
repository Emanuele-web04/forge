import type { OrchestrationThreadActivity } from "@synara/contracts";

const backgroundTaskStatesCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlyMap<string, boolean>
>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

// A local_bash task alone is not background evidence: Claude also emits one
// for foreground Bash calls. Older task events can use the tool input instead.
// Callers supply ordered activities; the latest explicit boolean wins over input.
export function collectTaskBackgroundStates(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, boolean> {
  const cached = backgroundTaskStatesCache.get(activities);
  if (cached) return cached;
  const backgroundToolIds = new Set<string>();
  const taskStates = new Map<string, boolean>();
  const explicitStates = new Map<string, boolean>();
  for (const activity of activities) {
    const payload = record(activity.payload);
    const data = record(payload?.data);
    if (record(data?.input)?.run_in_background === true) {
      const toolId = data?.toolCallId ?? data?.toolUseId;
      if (typeof toolId === "string") backgroundToolIds.add(toolId);
    }
    if (typeof payload?.isBackgrounded === "boolean" && typeof payload.taskId === "string") {
      explicitStates.set(payload.taskId, payload.isBackgrounded);
    }
  }
  for (const activity of activities) {
    const payload = record(activity.payload);
    if (
      activity.kind === "task.started" &&
      typeof payload?.taskId === "string" &&
      !explicitStates.has(payload.taskId) &&
      typeof payload.toolUseId === "string" &&
      backgroundToolIds.has(payload.toolUseId)
    ) {
      taskStates.set(payload.taskId, true);
    }
  }
  for (const [taskId, backgrounded] of explicitStates) {
    taskStates.set(taskId, backgrounded);
  }
  backgroundTaskStatesCache.set(activities, taskStates);
  return taskStates;
}

// Persisted session boundaries prevent tasks from a dead process returning on
// reload or after a replacement session starts. Normal turn completion is not
// a process boundary.
export function backgroundTaskSessionBoundary(
  activity: OrchestrationThreadActivity,
): "failed" | "cancelled" | undefined {
  if (activity.kind !== "provider.session.boundary") return undefined;
  return record(activity.payload)?.state === "error" ? "failed" : "cancelled";
}
