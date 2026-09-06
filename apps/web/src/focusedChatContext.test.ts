import { ProjectId, ThreadId } from "@synara/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { type DraftThreadState } from "./composerDraftStore";
import { useFocusedChatContext, type FocusedChatContext } from "./focusedChatContext";
import { initialState, type AppState } from "./storeState";
import { makeProject, makeThread } from "./storeTestFixtures";
import type { SplitView } from "./splitViewStore";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");

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

const fixtures = vi.hoisted(() => ({
  appState: null as AppState | null,
  params: {} as { threadId?: string },
  search: {} as { splitViewId?: string },
  draftState: { draftThreadsByThreadId: {} as Record<string, DraftThreadState> },
  splitState: { splitViewsById: {} as Record<string, SplitView> },
}));

vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: typeof fixtures.params) => unknown }) =>
    select(fixtures.params),
  useSearch: ({ select }: { select: (search: typeof fixtures.search) => unknown }) =>
    select(fixtures.search),
}));

vi.mock("./store", () => ({
  useStore: (select: (state: AppState) => unknown) => {
    if (!fixtures.appState) throw new Error("Missing focused-chat app state.");
    return select(fixtures.appState);
  },
}));

vi.mock("./composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: typeof fixtures.draftState) => unknown) =>
    select(fixtures.draftState),
}));

vi.mock("./splitViewStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./splitViewStore")>()),
  useSplitViewStore: (select: (state: typeof fixtures.splitState) => unknown) =>
    select(fixtures.splitState),
}));

function readFocusedChatContext(input: {
  routeThreadId: ThreadId | null;
  splitView: SplitView | null;
  threads: readonly Thread[];
  projects: Project[];
  draftThreadsByThreadId: Record<string, DraftThreadState>;
}): FocusedChatContext {
  fixtures.params = input.routeThreadId ? { threadId: input.routeThreadId } : {};
  fixtures.search = input.splitView ? { splitViewId: input.splitView.id } : {};
  fixtures.splitState.splitViewsById = input.splitView
    ? { [input.splitView.id]: input.splitView }
    : {};
  fixtures.draftState.draftThreadsByThreadId = input.draftThreadsByThreadId;
  fixtures.appState = {
    ...initialState,
    projects: input.projects,
    threadShellById: Object.fromEntries(input.threads.map((thread) => [thread.id, thread])),
  };
  const captured: { current: FocusedChatContext | null } = { current: null };
  function Probe() {
    captured.current = useFocusedChatContext();
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  if (!captured.current) throw new Error("Focused-chat probe did not render.");
  return captured.current;
}

describe("useFocusedChatContext", () => {
  it("uses the route thread when no split is selected", () => {
    const context = readFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: null,
      threads: [makeThread({ id: THREAD_A })],
      projects: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBe(THREAD_A);
    expect(context.activeThread?.id).toBe(THREAD_A);
    expect(context.activeProject?.id).toBe(PROJECT_ID);
  });

  it("uses the focused split pane thread instead of the route thread", () => {
    const context = readFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView(),
      threads: [makeThread({ id: THREAD_A }), makeThread({ id: THREAD_B })],
      projects: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBe(THREAD_B);
    expect(context.activeThread?.id).toBe(THREAD_B);
    expect(context.activeProjectId).toBe(PROJECT_ID);
  });

  it("falls back to the split owner project when the focused pane is empty", () => {
    const context = readFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView({
        secondThreadId: null,
        focusedSide: "second",
      }),
      threads: [makeThread({ id: THREAD_A })],
      projects: [makeProject()],
      draftThreadsByThreadId: {},
    });

    expect(context.focusedThreadId).toBeNull();
    expect(context.activeThread).toBeNull();
    expect(context.activeProjectId).toBe(PROJECT_ID);
    expect(context.activeProject?.id).toBe(PROJECT_ID);
  });

  it("prefers the focused draft thread when the pane points at a draft-only thread", () => {
    const draftThreadId = ThreadId.makeUnsafe("thread-draft");
    const draftProjectId = ProjectId.makeUnsafe("project-draft");
    const context = readFocusedChatContext({
      routeThreadId: THREAD_A,
      splitView: makeSplitView({
        secondThreadId: draftThreadId,
        focusedSide: "second",
      }),
      threads: [makeThread({ id: THREAD_A })],
      projects: [makeProject(), makeProject({ id: draftProjectId })],
      draftThreadsByThreadId: {
        [draftThreadId]: makeDraftThread({ projectId: draftProjectId, branch: "feature/split" }),
      },
    });

    expect(context.focusedThreadId).toBe(draftThreadId);
    expect(context.activeDraftThread?.branch).toBe("feature/split");
    expect(context.activeProjectId).toBe(draftProjectId);
    expect(context.activeProject?.id).toBe(draftProjectId);
  });
});
