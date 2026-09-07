/** Retain one accounting snapshot and completion per turn outside transcript caps. */
export function usageActivityIds<T extends { id: string; kind: string; turnId: string | null }>(
  activities: readonly T[],
): ReadonlySet<string> {
  const latest = new Map<string, string>();
  for (const activity of activities) {
    if (activity.kind === "context-window.updated" || activity.kind === "turn.completed")
      latest.set(`${activity.turnId ?? ""}:${activity.kind}`, activity.id);
  }
  return new Set(latest.values());
}

export function retainUsageActivities<
  T extends { id: string; kind: string; turnId: string | null },
>(activities: readonly T[], limit: number): T[] {
  if (activities.length <= limit) return activities as T[];
  const retained = usageActivityIds(activities);
  const cutoff = activities.length - limit;
  return activities.filter((activity, index) => index >= cutoff || retained.has(activity.id));
}
