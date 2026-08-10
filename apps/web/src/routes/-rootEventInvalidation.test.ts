// FILE: -rootEventInvalidation.test.ts
// Purpose: Covers root event cache invalidation decisions for streamed orchestration updates.
// Layer: Route utility unit tests
// Depends on: rootEventInvalidation predicates and Vitest assertions.

import { DEFAULT_PROVIDER_PROFILE_ID, ProjectId, ThreadId, type OrchestrationEvent } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  getGitInvalidationThreadIdForEvent,
  getProjectFileInvalidationThreadIdForEvent,
  getStudioOutputInvalidationThreadIdForEvent,
  resolveGitInvalidationCwdForThreadId,
  shouldInvalidateGitQueriesForEvent,
  shouldInvalidateProviderQueriesForEvent,
} from "./-rootEventInvalidation";
import type { AppState } from "../store";
import type { Thread } from "../types";

function event(type: OrchestrationEvent["type"], payload: object = {}): OrchestrationEvent {
  return {
    type,
    payload,
  } as OrchestrationEvent;
}

describe("root event invalidation", () => {
  it("invalidates git queries when a turn diff is finalized", () => {
    const turnDiffEvent = event("thread.turn-diff-completed");

    expect(shouldInvalidateGitQueriesForEvent(turnDiffEvent)).toBe(true);
    expect(shouldInvalidateProviderQueriesForEvent(turnDiffEvent)).toBe(true);
  });

  it("invalidates git queries when checkpoint changes can rewrite files", () => {
    expect(shouldInvalidateGitQueriesForEvent(event("thread.reverted"))).toBe(true);
    expect(shouldInvalidateGitQueriesForEvent(event("thread.conversation-rolled-back"))).toBe(true);
  });

  it("invalidates git queries when thread workspace metadata changes", () => {
    expect(
      shouldInvalidateGitQueriesForEvent(event("thread.meta-updated", { branch: "feature/diff" })),
    ).toBe(true);
  });

  it("leaves unrelated events alone", () => {
    expect(shouldInvalidateGitQueriesForEvent(event("thread.message-sent"))).toBe(false);
    expect(shouldInvalidateProviderQueriesForEvent(event("thread.message-sent"))).toBe(false);
  });

  it("extracts thread ids from mid-turn file-change activities", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const fileChangeActivity = (payload: unknown) =>
      event("thread.activity-appended", {
        threadId,
        activity: { payload },
      });

    expect(
      getProjectFileInvalidationThreadIdForEvent(
        fileChangeActivity({ requestKind: "file-change" }),
      ),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(fileChangeActivity({ itemType: "file_change" })),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(
        fileChangeActivity({ data: { item: { type: "file_change" } } }),
      ),
    ).toBe(threadId);
    expect(
      getProjectFileInvalidationThreadIdForEvent(fileChangeActivity({ requestKind: "command" })),
    ).toBe(null);
    expect(
      getProjectFileInvalidationThreadIdForEvent(event("thread.message-sent", { threadId })),
    ).toBe(null);
  });

  it("extracts affected thread ids for scoped git invalidation", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");

    expect(
      getGitInvalidationThreadIdForEvent(event("thread.turn-diff-completed", { threadId })),
    ).toBe(threadId);
    expect(getGitInvalidationThreadIdForEvent(event("thread.message-sent", { threadId }))).toBe(
      null,
    );
  });

  it("invalidates Studio outputs for file-change activities and finalized checkpoints", () => {
    const threadId = ThreadId.makeUnsafe("thread-studio");
    const fileChangeActivity = event("thread.activity-appended", {
      threadId,
      activity: { kind: "tool.completed", payload: { itemType: "file_change" } },
    });

    expect(getStudioOutputInvalidationThreadIdForEvent(fileChangeActivity)).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.activity-appended", {
          threadId,
          activity: { kind: "studio.outputs.captured", payload: { itemType: "studio_outputs" } },
        }),
      ),
    ).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.turn-diff-completed", { threadId }),
      ),
    ).toBe(threadId);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(event("thread.message-sent", { threadId })),
    ).toBe(null);
    expect(
      getStudioOutputInvalidationThreadIdForEvent(
        event("thread.activity-appended", {
          threadId,
          activity: { kind: "tool.updated", payload: { itemType: "file_change" } },
        }),
      ),
    ).toBe(null);
  });

  it("resolves local and worktree cwd from the current thread projection", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const localThreadId = ThreadId.makeUnsafe("thread-local");
    const worktreeThreadId = ThreadId.makeUnsafe("thread-worktree");
    const localThread = makeThread({
      id: localThreadId,
      projectId,
      envMode: "local",
      worktreePath: null,
    });
    const worktreeThread = makeThread({
      id: worktreeThreadId,
      projectId,
      envMode: "worktree",
      worktreePath: "/repo/worktree",
    });
    const state: AppState = {
      spaces: [],
      projects: [{ id: projectId, cwd: "/repo/main" }] as AppState["projects"],
      sidebarThreadSummaryById: {},
      threadsHydrated: true,
      threadIds: [localThreadId, worktreeThreadId],
      threadShellById: {
        [localThreadId]: localThread,
        [worktreeThreadId]: worktreeThread,
      },
    };

    expect(resolveGitInvalidationCwdForThreadId(state, localThreadId)).toBe("/repo/main");
    expect(resolveGitInvalidationCwdForThreadId(state, worktreeThreadId)).toBe("/repo/worktree");
  });
});

function makeThread(overrides: Partial<Thread>): Thread {
  return {
    id: ThreadId.makeUnsafe("thread"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project"),
    title: "Thread",
    modelSelection: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}
