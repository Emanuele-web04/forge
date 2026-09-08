import { ProjectId, ThreadId, TurnId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import type { DraftThreadState } from "../composerDraftStore";
import type { Thread } from "../types";
import {
  buildDiffPanelCompareRefValue,
  filterRenderableFilesForSearch,
  resolveAdjacentDiffFilePath,
  resolveDiffChangeMarkers,
  resolveDiffChangeMarkerKind,
  DIFF_CHANGE_MARKER_HEIGHT_PX,
  isDiffPanelRepoScopeOption,
  isStaleDiffTurnSelection,
  resolveConversationCacheScope,
  resolveDiffPanelGitStatusQueriesEnabled,
  resolveDiffPanelPickerLabel,
  resolveDiffPanelQueriesEnabled,
  resolveDiffPanelRepoLiveRefresh,
  resolveDiffPanelRepoLiveRefetchIntervalMs,
  resolveDiffPanelScopeCountQueriesEnabled,
  resolveDiffPanelScopeFileCounts,
  resolveDiffPanelScopePickerValue,
  resolveDiffPanelThread,
  resolveDiffPanelViewSource,
  resolveWatchedDiffFilePath,
  resolveDiffSelectAllArmed,
  resolveDiffSelectAllWithinViewport,
  parseDiffPanelCompareRefValue,
  resolveInitialDiffViewKind,
  resolveSelectedTurnSummary,
  DIFF_PANEL_PICKER_SCOPE_OPTIONS,
  DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS,
} from "./DiffPanel.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");
const THREAD_ID = ThreadId.makeUnsafe("thread-1");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: THREAD_ID,
    codexThreadId: null,
    projectId: PROJECT_ID,
    title: "Thread 1",
    modelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-04-16T10:00:00.000Z",
    updatedAt: "2026-04-16T10:00:00.000Z",
    latestTurn: {
      turnId: TurnId.makeUnsafe("turn-1"),
      state: "completed",
      requestedAt: "2026-04-16T10:00:00.000Z",
      startedAt: "2026-04-16T10:00:01.000Z",
      completedAt: "2026-04-16T10:00:02.000Z",
      assistantMessageId: null,
      sourceProposedPlan: undefined,
    },
    lastVisitedAt: "2026-04-16T10:00:02.000Z",
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
    createdAt: "2026-04-16T10:00:00.000Z",
    runtimeMode: "full-access",
    interactionMode: "default",
    entryPoint: "chat",
    branch: null,
    worktreePath: null,
    envMode: "local",
    ...overrides,
  };
}

describe("resolveDiffPanelThread", () => {
  it("keeps the server-backed thread when one exists", () => {
    const serverThread = makeThread({ title: "Server thread" });

    expect(
      resolveDiffPanelThread({
        threadId: THREAD_ID,
        serverThread,
        draftThread: makeDraftThread({ branch: "feature/draft" }),
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toBe(serverThread);
  });

  it("builds a local draft-backed thread when the server thread is missing", () => {
    const resolved = resolveDiffPanelThread({
      threadId: THREAD_ID,
      serverThread: undefined,
      draftThread: makeDraftThread({
        branch: "feature/draft",
        worktreePath: "/tmp/worktree",
        envMode: "worktree",
      }),
      fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
    });

    expect(resolved).toMatchObject({
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "New thread",
      envMode: "worktree",
      branch: "feature/draft",
      worktreePath: "/tmp/worktree",
      turnDiffSummaries: [],
    });
  });

  it("returns undefined when neither a server thread nor a draft thread exists", () => {
    expect(
      resolveDiffPanelThread({
        threadId: THREAD_ID,
        serverThread: undefined,
        draftThread: null,
        fallbackModelSelection: { provider: "codex", model: "gpt-5.4-mini" },
      }),
    ).toBeUndefined();
  });
});

describe("diff panel view source helpers", () => {
  it("defaults to repo view when no turn is selected", () => {
    expect(resolveInitialDiffViewKind(null)).toBe("repo");
  });

  it("defaults to turn view when a turn is selected", () => {
    expect(resolveInitialDiffViewKind(TurnId.makeUnsafe("turn-1"))).toBe("turn");
  });

  it("resolves repo and turn view sources", () => {
    expect(
      resolveDiffPanelViewSource({
        diffViewKind: "repo",
        repoDiffScope: "unstaged",
        selectedTurnId: null,
      }),
    ).toEqual({ kind: "repo", scope: "unstaged" });

    expect(
      resolveDiffPanelViewSource({
        diffViewKind: "turn",
        repoDiffScope: "branch",
        selectedTurnId: TurnId.makeUnsafe("turn-1"),
      }),
    ).toEqual({ kind: "turn", turnId: TurnId.makeUnsafe("turn-1") });
  });

  it("gates diff queries when the pane is hidden or collapsed", () => {
    expect(resolveDiffPanelQueriesEnabled({ diffOpen: true, queriesEnabled: true })).toBe(true);
    expect(resolveDiffPanelQueriesEnabled({ diffOpen: true, queriesEnabled: false })).toBe(false);
    expect(resolveDiffPanelQueriesEnabled({ diffOpen: false, queriesEnabled: true })).toBe(false);
    expect(
      resolveDiffPanelScopeCountQueriesEnabled({ queriesEnabled: true, scopePickerOpen: false }),
    ).toBe(false);
    expect(
      resolveDiffPanelScopeCountQueriesEnabled({ queriesEnabled: true, scopePickerOpen: true }),
    ).toBe(true);
  });

  it("only enables git status work for repo diffs with a cwd", () => {
    expect(
      resolveDiffPanelGitStatusQueriesEnabled({
        queriesEnabled: true,
        activeCwd: "/repo",
        diffViewKind: "repo",
      }),
    ).toBe(true);
    expect(
      resolveDiffPanelGitStatusQueriesEnabled({
        queriesEnabled: true,
        activeCwd: "/repo",
        diffViewKind: "turn",
      }),
    ).toBe(false);
    expect(
      resolveDiffPanelGitStatusQueriesEnabled({
        queriesEnabled: true,
        activeCwd: null,
        diffViewKind: "repo",
      }),
    ).toBe(false);
  });

  it("only surfaces scope file counts for the active scope until the picker opens", () => {
    expect(
      resolveDiffPanelScopeFileCounts({
        viewSource: { kind: "repo", scope: "unstaged" },
        activeScopeFileCount: 3,
        scopePickerOpen: false,
        pickerScopeCounts: { unstaged: 3, staged: 1 },
      }),
    ).toEqual({ unstaged: 3 });
    expect(
      resolveDiffPanelScopeFileCounts({
        viewSource: { kind: "repo", scope: "unstaged" },
        activeScopeFileCount: 3,
        scopePickerOpen: true,
        pickerScopeCounts: { unstaged: 3, staged: 1 },
      }),
    ).toEqual({ unstaged: 3, staged: 1 });
  });

  it("only polls repo diffs while a turn is live and the repo view is active", () => {
    expect(
      resolveDiffPanelRepoLiveRefresh({
        latestTurn: null,
        session: null,
        messages: [],
        activities: [],
      }),
    ).toBe(false);
    expect(
      resolveDiffPanelRepoLiveRefresh({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "running",
          requestedAt: "2026-04-16T10:00:00.000Z",
          startedAt: "2026-04-16T10:00:01.000Z",
          completedAt: null,
          assistantMessageId: null,
          sourceProposedPlan: undefined,
        },
        session: {
          provider: "codex",
          status: "running",
          orchestrationStatus: "running",
          activeTurnId: TurnId.makeUnsafe("turn-1"),
          createdAt: "2026-04-16T10:00:00.000Z",
          updatedAt: "2026-04-16T10:00:01.000Z",
        },
        messages: [],
        activities: [],
      }),
    ).toBe(true);
    expect(
      resolveDiffPanelRepoLiveRefetchIntervalMs({
        queriesEnabled: true,
        liveRefreshEnabled: true,
        diffViewKind: "repo",
        shouldPollRepoDiff: true,
      }),
    ).toBe(DIFF_PANEL_REPO_LIVE_REFETCH_INTERVAL_MS);
    expect(
      resolveDiffPanelRepoLiveRefetchIntervalMs({
        queriesEnabled: true,
        liveRefreshEnabled: true,
        diffViewKind: "turn",
        shouldPollRepoDiff: true,
      }),
    ).toBe(false);
  });

  it("resolves scope picker values for repo, all turns, and last turn", () => {
    const latestTurnId = TurnId.makeUnsafe("turn-latest");
    const olderTurnId = TurnId.makeUnsafe("turn-older");

    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "repo", scope: "workingTree" },
        latestTurnId,
      }),
    ).toBe("workingTree");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "repo", scope: "staged" },
        latestTurnId,
      }),
    ).toBe("staged");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "turn", turnId: null },
        latestTurnId,
      }),
    ).toBe("allTurns");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "turn", turnId: null },
        latestTurnId,
        turnScopeIntent: "last",
      }),
    ).toBe("lastTurn");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "turn", turnId: latestTurnId },
        latestTurnId,
      }),
    ).toBe("lastTurn");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "turn", turnId: olderTurnId },
        latestTurnId,
      }),
    ).toBeNull();
  });

  it("keeps the persisted default working-tree scope available in the picker", () => {
    expect(DIFF_PANEL_PICKER_SCOPE_OPTIONS).toContain("workingTree");
  });

  it("keeps the ref scope out of the plain scope option list", () => {
    expect(DIFF_PANEL_PICKER_SCOPE_OPTIONS).not.toContain("ref");
    expect(isDiffPanelRepoScopeOption("ref")).toBe(false);
    expect(isDiffPanelRepoScopeOption("branch")).toBe(true);
  });

  it("round-trips compare ref picker values", () => {
    expect(buildDiffPanelCompareRefValue("feature/x")).toBe("ref:feature/x");
    expect(parseDiffPanelCompareRefValue("ref:feature/x")).toBe("feature/x");
    expect(parseDiffPanelCompareRefValue("ref:  ")).toBeNull();
    expect(parseDiffPanelCompareRefValue("branch")).toBeNull();
  });

  it("resolves the compare-ref picker value and label from the active ref", () => {
    const latestTurnId = TurnId.makeUnsafe("turn-latest");

    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "repo", scope: "ref" },
        latestTurnId,
        compareRef: "release/1.2",
      }),
    ).toBe("ref:release/1.2");
    expect(
      resolveDiffPanelScopePickerValue({
        viewSource: { kind: "repo", scope: "ref" },
        latestTurnId,
        compareRef: null,
      }),
    ).toBeNull();
    expect(
      resolveDiffPanelPickerLabel({ kind: "repo", scope: "ref" }, undefined, "release/1.2"),
    ).toBe("vs release/1.2");
    expect(
      resolveDiffPanelPickerLabel(
        { kind: "repo", scope: "ref" },
        undefined,
        "0123456789abcdef0123456789abcdef01234567",
      ),
    ).toBe("vs 0123456");
  });

  it("surfaces a ref scope file count in the picker badges", () => {
    expect(
      resolveDiffPanelScopeFileCounts({
        viewSource: { kind: "repo", scope: "ref" },
        activeScopeFileCount: 4,
        scopePickerOpen: false,
        pickerScopeCounts: {},
      }),
    ).toEqual({ ref: 4 });
  });

  it("detects stale turn selections and resolves summaries without fallback", () => {
    const summaries = [
      {
        turnId: TurnId.makeUnsafe("turn-1"),
        checkpointTurnCount: 1,
        completedAt: "2026-04-16T10:00:02.000Z",
      },
    ] as const;

    expect(resolveSelectedTurnSummary(TurnId.makeUnsafe("turn-1"), summaries)).toMatchObject({
      turnId: TurnId.makeUnsafe("turn-1"),
    });
    expect(
      resolveSelectedTurnSummary(TurnId.makeUnsafe("turn-missing"), summaries),
    ).toBeUndefined();
    expect(isStaleDiffTurnSelection(TurnId.makeUnsafe("turn-missing"), summaries)).toBe(true);
    expect(isStaleDiffTurnSelection(null, summaries)).toBe(false);
  });

  it("builds compact conversation cache scopes from the latest checkpoint count", () => {
    expect(resolveConversationCacheScope(undefined)).toBeNull();
    expect(resolveConversationCacheScope(3)).toBe("conversation:to-3");
  });

  it("filters renderable files by path query", () => {
    const files = [
      { name: "apps/web/src/components/ChatView.tsx", hunks: [] },
      { name: "apps/web/src/components/DiffPanel.tsx", hunks: [] },
    ] as unknown as Parameters<typeof filterRenderableFilesForSearch>[0];

    expect(filterRenderableFilesForSearch(files, "diffpanel")).toHaveLength(1);
    expect(filterRenderableFilesForSearch(files, "")).toHaveLength(2);
  });

  it("falls back to the first visible diff when the selected file is stale", () => {
    const files = [
      { name: "src/visible.ts", hunks: [] },
      { name: "src/other.ts", hunks: [] },
    ] as unknown as Parameters<typeof resolveWatchedDiffFilePath>[1];

    expect(resolveWatchedDiffFilePath("src/other.ts", files)).toBe("src/other.ts");
    expect(resolveWatchedDiffFilePath("src/stale.ts", files)).toBe("src/visible.ts");
    expect(resolveWatchedDiffFilePath(null, [])).toBeNull();
  });
});

describe("resolveDiffSelectAllArmed", () => {
  it("arms on Cmd/Ctrl+A inside the diff viewport", () => {
    expect(
      resolveDiffSelectAllArmed(false, { key: "a", metaKey: true, ctrlKey: false }, true),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(false, { key: "A", metaKey: false, ctrlKey: true }, true),
    ).toBe(true);
  });

  it("does not arm on Cmd/Ctrl+A outside the diff viewport", () => {
    expect(
      resolveDiffSelectAllArmed(false, { key: "a", metaKey: true, ctrlKey: false }, false),
    ).toBe(false);
    expect(
      resolveDiffSelectAllArmed(true, { key: "a", metaKey: false, ctrlKey: true }, false),
    ).toBe(false);
  });

  it("preserves the armed state through the copy half of the gesture", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "c", metaKey: true, ctrlKey: false }, false),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(false, { key: "c", metaKey: true, ctrlKey: false }, false),
    ).toBe(false);
  });

  it("preserves the armed state through bare modifier keydowns", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "Meta", metaKey: true, ctrlKey: false }, false),
    ).toBe(true);
    expect(
      resolveDiffSelectAllArmed(true, { key: "Shift", metaKey: false, ctrlKey: false }, false),
    ).toBe(true);
  });

  it("disarms on any other key that starts a fresh selection", () => {
    expect(
      resolveDiffSelectAllArmed(true, { key: "ArrowDown", metaKey: false, ctrlKey: false }, true),
    ).toBe(false);
    expect(
      resolveDiffSelectAllArmed(true, { key: "x", metaKey: false, ctrlKey: false }, true),
    ).toBe(false);
  });
});

describe("resolveDiffSelectAllWithinViewport", () => {
  it("uses the last pointer hit for non-focusable diff chrome", () => {
    expect(resolveDiffSelectAllWithinViewport(false, true, false)).toBe(true);
  });

  it("does not use stale diff pointer state for an external text editor", () => {
    expect(resolveDiffSelectAllWithinViewport(false, true, true)).toBe(false);
  });

  it("keeps direct events inside the diff authoritative", () => {
    expect(resolveDiffSelectAllWithinViewport(true, false, true)).toBe(true);
  });
});

describe("resolveAdjacentDiffFilePath", () => {
  const FILE_PATHS = ["a.ts", "b.ts", "c.ts"];

  it("returns null when there are no files", () => {
    expect(resolveAdjacentDiffFilePath([], null, "next")).toBeNull();
    expect(resolveAdjacentDiffFilePath([], "a.ts", "previous")).toBeNull();
  });

  it("moves to the neighbouring file in both directions", () => {
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "a.ts", "next")).toBe("b.ts");
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "b.ts", "next")).toBe("c.ts");
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "c.ts", "previous")).toBe("b.ts");
  });

  it("clamps at both ends instead of wrapping around", () => {
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "c.ts", "next")).toBeNull();
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "a.ts", "previous")).toBeNull();
  });

  it("starts at the first file when the active file is unknown", () => {
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, null, "next")).toBe("a.ts");
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, "gone.ts", "next")).toBe("a.ts");
    expect(resolveAdjacentDiffFilePath(FILE_PATHS, null, "previous")).toBeNull();
  });
});

describe("resolveDiffChangeMarkerKind", () => {
  it("maps git change types onto marker colors", () => {
    expect(resolveDiffChangeMarkerKind("new")).toBe("added");
    expect(resolveDiffChangeMarkerKind("deleted")).toBe("removed");
    expect(resolveDiffChangeMarkerKind("change")).toBe("modified");
    expect(resolveDiffChangeMarkerKind("rename-pure")).toBe("modified");
    expect(resolveDiffChangeMarkerKind("rename-changed")).toBe("modified");
  });
});

describe("resolveDiffChangeMarkers", () => {
  it("returns nothing for an empty file list", () => {
    expect(resolveDiffChangeMarkers({ files: [], scrollHeight: 1000, stripHeight: 200 })).toEqual(
      [],
    );
  });

  it("returns nothing when the scroll surface has no measurable height", () => {
    expect(
      resolveDiffChangeMarkers({
        files: [{ path: "a.ts", offsetTop: 0, changeType: "change" }],
        scrollHeight: 0,
        stripHeight: 200,
      }),
    ).toEqual([]);
  });

  it("positions markers proportionally within the strip", () => {
    const markers = resolveDiffChangeMarkers({
      files: [
        { path: "a.ts", offsetTop: 0, changeType: "new" },
        { path: "b.ts", offsetTop: 500, changeType: "change" },
      ],
      scrollHeight: 1000,
      stripHeight: 200,
    });

    expect(markers).toEqual([
      { path: "a.ts", kind: "added", top: 0 },
      { path: "b.ts", kind: "modified", top: 100 },
    ]);
  });

  it("clamps the last marker inside the strip", () => {
    const markers = resolveDiffChangeMarkers({
      files: [{ path: "z.ts", offsetTop: 4000, changeType: "deleted" }],
      scrollHeight: 1000,
      stripHeight: 200,
    });

    expect(markers).toEqual([
      { path: "z.ts", kind: "removed", top: 200 - DIFF_CHANGE_MARKER_HEIGHT_PX },
    ]);
  });

  it("keeps markers at the strip origin when the strip has no height", () => {
    const markers = resolveDiffChangeMarkers({
      files: [{ path: "a.ts", offsetTop: 250, changeType: "change" }],
      scrollHeight: 1000,
      stripHeight: 0,
    });

    expect(markers).toEqual([{ path: "a.ts", kind: "modified", top: 0 }]);
  });
});
