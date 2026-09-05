// FILE: -rootEventInvalidation.ts
// Purpose: Classifies streamed orchestration events that invalidate shared query caches.
// Layer: Root route utility
// Exports: Event invalidation predicates for provider, project, Git, and Studio output caches.

import {
  STUDIO_OUTPUTS_ACTIVITY_KIND,
  type OrchestrationEvent,
  type ThreadId,
} from "@synara/contracts";
import { resolveThreadWorkspaceCwd } from "@synara/shared/threadEnvironment";

import type { AppState } from "../storeState";
import { getThreadFromState } from "../threadDerivation";

const FILE_CHANGE_EVENT_TYPES = new Set<OrchestrationEvent["type"]>([
  "thread.turn-diff-completed",
  "thread.reverted",
  "thread.conversation-rolled-back",
]);

export function shouldInvalidateProviderQueriesForEvent(event: OrchestrationEvent): boolean {
  return FILE_CHANGE_EVENT_TYPES.has(event.type);
}

export function shouldInvalidateGitQueriesForEvent(event: OrchestrationEvent): boolean {
  if (FILE_CHANGE_EVENT_TYPES.has(event.type) || isPotentiallyFileMutatingToolCompletion(event)) {
    return true;
  }

  if (event.type !== "thread.meta-updated") {
    return false;
  }

  return (
    event.payload.branch !== undefined ||
    event.payload.envMode !== undefined ||
    event.payload.worktreePath !== undefined ||
    event.payload.associatedWorktreePath !== undefined ||
    event.payload.associatedWorktreeBranch !== undefined ||
    event.payload.associatedWorktreeRef !== undefined
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function activityItemType(event: OrchestrationEvent): unknown {
  if (event.type !== "thread.activity-appended") {
    return null;
  }
  const payload = isRecord(event.payload.activity.payload) ? event.payload.activity.payload : null;
  const data = payload && isRecord(payload.data) ? payload.data : null;
  const item = data && isRecord(data.item) ? data.item : null;
  return payload?.itemType ?? data?.itemType ?? item?.type ?? item?.kind;
}

function isPotentiallyFileMutatingToolCompletion(event: OrchestrationEvent): boolean {
  if (
    event.type !== "thread.activity-appended" ||
    event.payload.activity.kind !== "tool.completed"
  ) {
    return false;
  }
  // Known read-only tools should not trigger expensive file/diff reads. Every
  // other completed tool can write through a shell, MCP, subagent, script, or
  // provider-specific payload, including older payloads with no itemType.
  const itemType = activityItemType(event);
  return itemType !== "web_search" && itemType !== "image_view";
}

// Activities stream while a turn is still running; file-change tool calls are the
// earliest signal that workspace files were touched. Invalidating the project
// file queries on them lets the editor file tree and open file preview refresh
// mid-turn instead of waiting for the turn diff to complete.
export function getProjectFileInvalidationThreadIdForEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  if (FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
  }
  if (event.type !== "thread.activity-appended") {
    return null;
  }
  const payload = isRecord(event.payload.activity.payload) ? event.payload.activity.payload : null;
  if (!payload) {
    return null;
  }
  if (
    payload.requestKind === "file-change" ||
    activityItemType(event) === "file_change" ||
    isPotentiallyFileMutatingToolCompletion(event)
  ) {
    return event.payload.threadId;
  }
  return null;
}

/** Invalidates one Studio output list after attribution or filesystem state changes. */
export function getStudioOutputInvalidationThreadIdForEvent(
  event: OrchestrationEvent,
): ThreadId | null {
  if (event.type === "thread.activity-appended") {
    // Server-side per-turn output capture is the authoritative attribution signal.
    if (event.payload.activity.kind === STUDIO_OUTPUTS_ACTIVITY_KIND) {
      return event.payload.threadId;
    }
    return event.payload.activity.kind === "tool.completed"
      ? getProjectFileInvalidationThreadIdForEvent(event)
      : null;
  }
  if (!FILE_CHANGE_EVENT_TYPES.has(event.type)) {
    return null;
  }
  return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
}

export function getGitInvalidationThreadIdForEvent(event: OrchestrationEvent): ThreadId | null {
  if (!shouldInvalidateGitQueriesForEvent(event)) {
    return null;
  }
  return "threadId" in event.payload ? (event.payload.threadId as ThreadId) : null;
}

// Resolve after domain events apply, so worktree metadata changes target the new cwd.
export function resolveGitInvalidationCwdForThreadId(
  state: AppState,
  threadId: ThreadId,
): string | null {
  const thread = getThreadFromState(state, threadId);
  if (!thread) {
    return null;
  }
  const projectCwd = state.projects.find((project) => project.id === thread.projectId)?.cwd ?? null;
  return resolveThreadWorkspaceCwd({
    projectCwd,
    envMode: thread.envMode,
    worktreePath: thread.worktreePath,
  });
}
