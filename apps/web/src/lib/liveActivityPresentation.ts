// FILE: liveActivityPresentation.ts
// Purpose: Provider-agnostic labels and live timing for normalized transcript activity.
// Layer: Web presentation helper

import { useSyncExternalStore } from "react";

import type { WorkLogLiveActivity } from "../workLog";
import { formatClockDuration } from "../session-logic";

const NO_ACTIVITY_THRESHOLD_MS = 30_000;
const LIVE_ACTIVITY_TICK_MS = 1_000;
const liveActivityClockListeners = new Set<() => void>();
let liveActivityClockIntervalId: number | null = null;
let liveActivityClockNowMs = Date.now();

function emitLiveActivityClockTick(): void {
  liveActivityClockNowMs = Date.now();
  for (const listener of liveActivityClockListeners) {
    listener();
  }
}

function subscribeLiveActivityClock(listener: () => void): () => void {
  liveActivityClockListeners.add(listener);
  if (liveActivityClockListeners.size === 1) {
    liveActivityClockNowMs = Date.now();
    liveActivityClockIntervalId = window.setInterval(
      emitLiveActivityClockTick,
      LIVE_ACTIVITY_TICK_MS,
    );
  }

  return () => {
    liveActivityClockListeners.delete(listener);
    if (liveActivityClockListeners.size === 0 && liveActivityClockIntervalId !== null) {
      window.clearInterval(liveActivityClockIntervalId);
      liveActivityClockIntervalId = null;
    }
  };
}

function subscribeInactiveLiveActivityClock(): () => void {
  return () => {};
}

function getLiveActivityClockSnapshot(): number {
  return liveActivityClockNowMs;
}

export function isLiveActivityInProgress(activity: WorkLogLiveActivity): boolean {
  return (
    activity.state === "starting" ||
    activity.state === "thinking" ||
    activity.state === "running_tool" ||
    activity.state === "waiting" ||
    activity.state === "streaming"
  );
}

export function useLiveActivityNow(activity: WorkLogLiveActivity | undefined): number {
  const inProgress = activity ? isLiveActivityInProgress(activity) : false;
  const nowMs = useSyncExternalStore(
    inProgress ? subscribeLiveActivityClock : subscribeInactiveLiveActivityClock,
    getLiveActivityClockSnapshot,
    getLiveActivityClockSnapshot,
  );
  return inProgress ? nowMs : Date.now();
}

function parseTimestamp(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function liveActivityElapsedMs(activity: WorkLogLiveActivity, nowMs: number): number | null {
  const startedAtMs = parseTimestamp(activity.startedAt);
  const lastActivityAtMs = parseTimestamp(activity.lastActivityAt);
  const reportedElapsedMs =
    activity.elapsedSeconds !== undefined && activity.elapsedSeconds >= 0
      ? activity.elapsedSeconds * 1_000
      : null;

  if (isLiveActivityInProgress(activity)) {
    if (reportedElapsedMs !== null && lastActivityAtMs !== null) {
      return reportedElapsedMs + Math.max(0, nowMs - lastActivityAtMs);
    }
    return startedAtMs === null ? null : Math.max(0, nowMs - startedAtMs);
  }

  if (reportedElapsedMs !== null) return reportedElapsedMs;
  if (startedAtMs === null || lastActivityAtMs === null || lastActivityAtMs < startedAtMs) {
    return null;
  }
  return lastActivityAtMs - startedAtMs;
}

export function formatLiveActivityProgress(progress: number): string {
  const percent = progress >= 0 && progress <= 1 ? progress * 100 : progress;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function formatLiveActivityStateLabel(state: WorkLogLiveActivity["state"]): string {
  switch (state) {
    case "starting":
      return "Starting";
    case "thinking":
      return "Thinking";
    case "running_tool":
      return "Running tool";
    case "waiting":
      return "Waiting";
    case "streaming":
      return "Streaming";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export function formatLiveActivityElapsed(
  activity: WorkLogLiveActivity,
  nowMs: number,
): string | null {
  const elapsedMs = liveActivityElapsedMs(activity, nowMs);
  return elapsedMs === null ? null : formatClockDuration(elapsedMs);
}

// Live meta only exists to explain work the row can't state on its own: how long
// something in flight has been running, or that it ended badly. A tool call that
// simply succeeded already reads as a finished sentence ("Searched for foo in
// src"), so it gets no status/elapsed tail — that detail lives in the disclosure.
export function formatLiveActivityMeta(
  activity: WorkLogLiveActivity,
  nowMs: number,
): string | null {
  if (activity.state === "completed") {
    return null;
  }

  const parts: string[] = [];
  const elapsed = formatLiveActivityElapsed(activity, nowMs);
  const lastActivityAtMs = parseTimestamp(activity.lastActivityAt);

  if (isLiveActivityInProgress(activity)) {
    if (lastActivityAtMs !== null) {
      const idleMs = Math.max(0, nowMs - lastActivityAtMs);
      parts.push(
        idleMs >= NO_ACTIVITY_THRESHOLD_MS
          ? `No activity for ${formatClockDuration(idleMs)}`
          : idleMs < 1_000
            ? "Active now"
            : `Active ${formatClockDuration(idleMs)} ago`,
      );
    }
  } else {
    parts.push(formatLiveActivityStateLabel(activity.state));
  }

  if (elapsed !== null) {
    parts.push(`${elapsed} elapsed`);
  }
  if (activity.progress !== undefined) {
    parts.push(formatLiveActivityProgress(activity.progress));
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
