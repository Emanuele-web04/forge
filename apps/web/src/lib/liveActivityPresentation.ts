// FILE: liveActivityPresentation.ts
// Purpose: Provider-agnostic labels and live timing for normalized transcript activity.
// Layer: Web presentation helper

import { useEffect, useState } from "react";

import type { WorkLogEntry, WorkLogLiveActivity } from "../workLog";
import { formatClockDuration } from "../session-logic";
import { deriveReadableCommandDisplay } from "./toolCallLabel";

const NO_ACTIVITY_THRESHOLD_MS = 30_000;
const LIVE_ACTIVITY_TICK_MS = 1_000;

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
  const [nowMs, setNowMs] = useState(() => Date.now());
  const inProgress = activity ? isLiveActivityInProgress(activity) : false;

  useEffect(() => {
    setNowMs(Date.now());
    if (!inProgress) return;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), LIVE_ACTIVITY_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [inProgress]);

  return nowMs;
}

function parseTimestamp(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

export function liveActivityElapsedMs(
  activity: WorkLogLiveActivity,
  nowMs: number,
): number | null {
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

function firstCommandExecutable(rawCommand: string): string {
  const trimmed = rawCommand.trim();
  const match = /^(?:"([^"]+)"|'([^']+)'|(\S+))/u.exec(trimmed);
  const executable = match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
  return executable.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
}

export function friendlyLiveCommandTarget(rawCommand: string): string {
  const executable = firstCommandExecutable(rawCommand);
  if (
    executable === "pwsh" ||
    executable === "pwsh.exe" ||
    executable === "powershell" ||
    executable === "powershell.exe"
  ) {
    return "PowerShell";
  }
  if (executable === "cmd" || executable === "cmd.exe") {
    return "Command Prompt";
  }

  const target = deriveReadableCommandDisplay(rawCommand, true).target.trim();
  return target.length <= 72 ? target : `${target.slice(0, 69).trimEnd()}…`;
}

function activitySubject(entry: Pick<WorkLogEntry, "itemType" | "requestKind">): string {
  if (entry.requestKind === "command" || entry.itemType === "command_execution") return "command";
  if (entry.requestKind === "file-read") return "file read";
  if (entry.requestKind === "file-change" || entry.itemType === "file_change") return "edit";
  if (entry.itemType === "web_search") return "search";
  if (entry.itemType === "collab_agent_tool_call") return "agent";
  return "tool";
}

function activityStateLead(
  activity: WorkLogLiveActivity,
  subject: string,
): string {
  switch (activity.state) {
    case "starting":
      return `Starting ${subject}`;
    case "thinking":
      return "Thinking";
    case "running_tool":
      return `Running ${subject}`;
    case "waiting":
      return "Waiting";
    case "streaming":
      return "Streaming";
    case "completed":
      return `Completed ${subject}`;
    case "failed":
      return `Failed ${subject}`;
    case "cancelled":
      return `Cancelled ${subject}`;
  }
}

export function formatLiveActivityPrimary(input: {
  activity: WorkLogLiveActivity;
  entry: Pick<WorkLogEntry, "itemType" | "requestKind">;
  heading: string;
  rawCommand?: string | undefined;
}): string {
  const subject = activitySubject(input.entry);
  const lead = activityStateLead(input.activity, subject);
  const target = input.rawCommand
    ? friendlyLiveCommandTarget(input.rawCommand)
    : (input.activity.label || input.heading).trim();
  return target ? `${lead} · ${target}` : lead;
}

function formatActivityProgress(progress: number): string {
  const percent = progress >= 0 && progress <= 1 ? progress * 100 : progress;
  return `${Math.round(Math.min(100, Math.max(0, percent)))}%`;
}

export function formatLiveActivityMeta(
  activity: WorkLogLiveActivity,
  nowMs: number,
): string | null {
  const parts: string[] = [];
  const elapsedMs = liveActivityElapsedMs(activity, nowMs);
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
    switch (activity.state) {
      case "completed":
        parts.push("Completed");
        break;
      case "failed":
        parts.push("Failed");
        break;
      case "cancelled":
        parts.push("Cancelled");
        break;
      default:
        parts.push(activityStateLead(activity, "tool"));
        break;
    }
  }

  if (elapsedMs !== null) {
    parts.push(`${formatClockDuration(elapsedMs)} elapsed`);
  }
  if (activity.progress !== undefined) {
    parts.push(formatActivityProgress(activity.progress));
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}
