import { DEFAULT_PROVIDER_PROFILE_ID, ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { type DraftThreadState } from "./composerDraftStore";
import { resolveFocusedChatContext } from "./focusedChatContext";
import type { Project, Thread } from "./types";
import type { SplitView } from "./splitViewStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

function makeProject(): Project {
  return {
    id: PROJECT_ID,
    kind: "project",
    name: "Project",
    remoteName: "Project",
    folderName: "project",
    localName: null,
    cwd: "/tmp/project",
    defaultModelSelection: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "gpt-5.4-mini" },
    expanded: true,
    spaceId: null,
    scripts: [],
  };
}

function makeThread(threadId: ThreadId, overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: `Thread ${threadId}`,
    modelSelection: { provider: "codex", profileId: DEFAULT_PROVIDER_PROFILE_ID, model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-07T10:00:00.000Z",
    updatedAt: "2026-04-07T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      requestedAt: "2026-04-07T10:00:00.000Z",
      startedAt: "2026-04-07T10:00:00.000Z",
      completedAt: "2026-04-07T10:01:00.000Z",
      assistantMessageId: null,
      sourceProposedPlan: undefined,
    },
    lastVisitedAt: "2026-04-07T10:01:00.000Z",
    branch: null,
    worktreePath: null,
    turnDiffSummaries: [],
    activities: [],
    ...overrides,
  };
}

function makeDraftThread(overrides: Partial<DraftThreadState> = {}): DraftThreadState {
  return {
    projectId: PROJECT_ID,
    createdAt: "2026-04-07T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    entryPoint: "chat",
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

interface SplitViewLayoutOverrides {
  firstThreadId?: ThreadId | null;
  secondThreadId?: ThreadId | null;
  focusedSide?: "first" | "second";
}

function makeSplitView(overrides: SplitViewLayoutOverrides = {}): SplitView {
  const firstLeaf = {
    kind: "leaf" as const,
    id: "pane-first",
    threadId: overrides.firstThreadId === undefined ? THREAD_A : overrides.firstThreadId,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser" as const,
    },
  };
  const secondLeaf = {
    kind: "leaf" as const,
    id: "pane-second",
    threadId: overrides.secondThreadId === undefined ? THREAD_B : overrides.secondThreadId,
    panel: {
      panel: null,
      diffTurnId: null,
      diffFilePath: null,
      hasOpenedPanel: false,
      lastOpenPanel: "browser" as const,
    },
  };
  const focusedSide = overrides.focusedSide ?? "second";
  return {
    id: "split-1",
    sourceThreadId: THREAD_A,
    ownerProjectId: PROJECT_ID,
    root: {
      kind: "split",
      id: "split-root",
      direction: "horizontal",
      first: firstLeaf,
      second: secondLeaf,
      ratio: 0.5,
    },
    focusedPaneId: focusedSide === "first" ? firstLeaf.id : secondLeaf.id,
    createdAt: "2026-04-07T10:00:00.000Z",
    updatedAt: "2026-04-07T10:00:00.000Z",
  };
}

describe("resolveFocusedChatContext", () => {
  it("uses the focused split pane thread instead of the route thread", () => {
    const context = resolveFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView(),
      threads: [makeThread(THREAD_A), makeThread(THREAD_B)],
      projects: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBe(THREAD_B);
    expect(context.activeThread?.id).toBe(THREAD_B);
    expect(context.activeProjectId).toBe(PROJECT_ID);
  });

  it("falls back to the split owner project when the focused pane is empty", () => {
    const context = resolveFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView({
        secondThreadId: null,
        focusedSide: "second",
      }),
      threads: [makeThread(THREAD_A)],
      projects: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBeNull();
    expect(context.activeThread).toBeNull();
    expect(context.activeProjectId).toBe(PROJECT_ID);
  });

  it("prefers the focused draft thread when the pane points at a draft-only thread", () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-draft");
    const context = resolveFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView({
        secondThreadId: draftThreadId,
        focusedSide: "second",
      }),
      threads: [makeThread(THREAD_A)],
      projects: [makeProject()],
      draftThreadsByThreadId: {
        [draftThreadId]: makeDraftThread({ branch: "feature/split" }),
      },
    });

    expect(context.focusedThreadId).toBe(draftThreadId);
    expect(context.activeDraftThread?.branch).toBe("feature/split");
    expect(context.activeProjectId).toBe(PROJECT_ID);
  });
});
