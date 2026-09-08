import type { OrchestrationThreadActivity } from "@synara/contracts";

const backgroundTaskIdsCache = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  ReadonlySet<string>
>();

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

// A local_bash task alone is not background evidence: Claude also emits one
// for foreground Bash calls. Older task events can use the tool input instead.
export function collectExplicitBackgroundTaskIds(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlySet<string> {
  const cached = backgroundTaskIdsCache.get(activities);
  if (cached) return cached;
  const backgroundToolIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const activity of activities) {
    const payload = record(activity.payload);
    const data = record(payload?.data);
    if (record(data?.input)?.run_in_background === true) {
      const toolId = data?.toolCallId ?? data?.toolUseId;
      if (typeof toolId === "string") backgroundToolIds.add(toolId);
    }
    if (payload?.isBackgrounded === true && typeof payload.taskId === "string") {
      taskIds.add(payload.taskId);
    }
  }
  for (const activity of activities) {
    const payload = record(activity.payload);
    if (
      activity.kind === "task.started" &&
      typeof payload?.taskId === "string" &&
      typeof payload.toolUseId === "string" &&
      backgroundToolIds.has(payload.toolUseId)
    ) {
      taskIds.add(payload.taskId);
    }
  }
  backgroundTaskIdsCache.set(activities, taskIds);
  return taskIds;
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
