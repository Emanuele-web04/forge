import { describe, expect, it } from "vitest";

import type { MessageId, ProjectId, ThreadId } from "@synara/contracts";

import type { AppState } from "./store";
import {
  createAccountRateLimitThreadsSelector,
  createAllThreadsSelector,
  createAllThreadsMessagelessSelector,
  createComposerThreadMentionSourcesSelector,
  createProjectLastActivityAtSelector,
  createSidebarDisplayThreadsSelector,
  createSidebarTreeThreadsSelector,
  createThreadExistsSelector,
  createThreadProjectIdSelector,
  createThreadShellsSelector,
  createThreadWorkspaceMetadataSelector,
  isSidebarThreadVisible,
} from "./storeSelectors";
import type { SidebarThreadSummary, ThreadShell } from "./types";

const threadIdA = "thread-a" as ThreadId;
const threadIdB = "thread-b" as ThreadId;
const messageId = "message-1" as MessageId;
const projectId = "project-1" as ProjectId;

const shellA = { id: threadIdA, projectId, title: "A" } as ThreadShell;
const shellB = { id: threadIdB, projectId, title: "B" } as ThreadShell;
const summaryA = {
  id: threadIdA,
  projectId,
  title: "A",
  modelSelection: { provider: "codex", model: "gpt-5-codex" },
  session: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  latestUserMessageAt: null,
} as SidebarThreadSummary;

interface TestStateSlices {
  threadIds?: readonly ThreadId[];
  threadShellById?: Readonly<Record<string, ThreadShell>>;
  sidebarThreadSummaryById?: Readonly<Record<string, SidebarThreadSummary>>;
  messageIdsByThreadId?: Readonly<Record<string, readonly MessageId[]>>;
  activityIdsByThreadId?: Readonly<Record<string, readonly string[]>>;
  activityByThreadId?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

function makeState(slices: TestStateSlices): AppState {
  return {
    threadIds: slices.threadIds ?? [],
    threadShellById: slices.threadShellById ?? {},
    sidebarThreadSummaryById: slices.sidebarThreadSummaryById ?? {},
    messageIdsByThreadId: slices.messageIdsByThreadId ?? {},
    activityIdsByThreadId: slices.activityIdsByThreadId ?? {},
    activityByThreadId: slices.activityByThreadId ?? {},
  } as unknown as AppState;
}

function makeActivity(id: string, kind: string) {
  return { id, kind, createdAt: "2026-01-01T00:00:00.000Z", payload: {} };
}

describe("createThreadShellsSelector", () => {
  it("returns shells in threadIds order", () => {
    const selectShells = createThreadShellsSelector();
    const state = makeState({
      threadIds: [threadIdB, threadIdA],
      threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
    });

    expect(selectShells(state).map((shell) => shell.id)).toEqual([threadIdB, threadIdA]);
  });

  it("stays reference-stable when unrelated state changes (e.g. streaming messages)", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];
    const threadShellById = { [threadIdA]: shellA };

    const before = selectShells(makeState({ threadIds, threadShellById }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
  });

  it("returns a new array when shells change", () => {
    const selectShells = createThreadShellsSelector();
    const threadIds = [threadIdA];

    const before = selectShells(makeState({ threadIds, threadShellById: { [threadIdA]: shellA } }));
    const after = selectShells(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: { ...shellA, title: "renamed" } },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.title).toBe("renamed");
  });
});

describe("createAccountRateLimitThreadsSelector", () => {
  const rateLimitActivity = makeActivity("activity-rate", "account.rate-limits.updated");
  const toolActivity = makeActivity("activity-tool", "provider.tool-call");

  it("collects only account rate-limit activities", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      activityIdsByThreadId: {
        [threadIdA]: [toolActivity.id, rateLimitActivity.id],
        [threadIdB]: [toolActivity.id],
      },
      activityByThreadId: {
        [threadIdA]: { [toolActivity.id]: toolActivity, [rateLimitActivity.id]: rateLimitActivity },
        [threadIdB]: { [toolActivity.id]: toolActivity },
      },
    });

    const result = selectRateLimitThreads(state);
    expect(result).toHaveLength(1);
    expect(result[0]?.activities).toEqual([rateLimitActivity]);
  });

  it("stays reference-stable when message slices change (streaming deltas)", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const threadIds = [threadIdA];
    const activityIdsByThreadId = { [threadIdA]: [rateLimitActivity.id] };
    const activityByThreadId = { [threadIdA]: { [rateLimitActivity.id]: rateLimitActivity } };

    const before = selectRateLimitThreads(
      makeState({ threadIds, activityIdsByThreadId, activityByThreadId }),
    );
    const after = selectRateLimitThreads(
      makeState({
        threadIds,
        activityIdsByThreadId,
        activityByThreadId,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
  });

  it("stays reference-stable when a non-rate-limit activity is appended", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const threadIds = [threadIdA];

    const before = selectRateLimitThreads(
      makeState({
        threadIds,
        activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id] },
        activityByThreadId: { [threadIdA]: { [rateLimitActivity.id]: rateLimitActivity } },
      }),
    );
    const after = selectRateLimitThreads(
      makeState({
        threadIds,
        activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id, toolActivity.id] },
        activityByThreadId: {
          [threadIdA]: {
            [rateLimitActivity.id]: rateLimitActivity,
            [toolActivity.id]: toolActivity,
          },
        },
      }),
    );

    expect(after).toBe(before);
  });

  it("returns a new result when a rate-limit activity is appended", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const threadIds = [threadIdA];
    const laterRateLimitActivity = makeActivity("activity-rate-2", "account.rate-limited");

    const before = selectRateLimitThreads(
      makeState({
        threadIds,
        activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id] },
        activityByThreadId: { [threadIdA]: { [rateLimitActivity.id]: rateLimitActivity } },
      }),
    );
    const after = selectRateLimitThreads(
      makeState({
        threadIds,
        activityIdsByThreadId: {
          [threadIdA]: [rateLimitActivity.id, laterRateLimitActivity.id],
        },
        activityByThreadId: {
          [threadIdA]: {
            [rateLimitActivity.id]: rateLimitActivity,
            [laterRateLimitActivity.id]: laterRateLimitActivity,
          },
        },
      }),
    );

    expect(after).not.toBe(before);
    expect(after[0]?.activities).toEqual([rateLimitActivity, laterRateLimitActivity]);
  });

  it("returns the empty constant when no thread has rate-limit activities", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const state = makeState({
      threadIds: [threadIdA],
      activityIdsByThreadId: { [threadIdA]: [toolActivity.id] },
      activityByThreadId: { [threadIdA]: { [toolActivity.id]: toolActivity } },
    });

    expect(selectRateLimitThreads(state)).toEqual([]);
  });
});

describe("sidebar thread visibility", () => {
  const threadIdC = "thread-c" as ThreadId;
  const runSummary = { ...summaryA, creationSource: "automation_run" } as SidebarThreadSummary;
  const pinnedRunSummary = {
    ...summaryA,
    id: threadIdB,
    title: "B",
    creationSource: "automation_run",
    isPinned: true,
  } as SidebarThreadSummary;
  const normalSummary = { ...summaryA, id: threadIdC, title: "C" } as SidebarThreadSummary;
  const state = makeState({
    threadIds: [threadIdA, threadIdB, threadIdC],
    sidebarThreadSummaryById: {
      [threadIdA]: runSummary,
      [threadIdB]: pinnedRunSummary,
      [threadIdC]: normalSummary,
    },
  });

  it("keeps every thread when the hide option is off", () => {
    expect(isSidebarThreadVisible(runSummary)).toBe(true);
    expect(isSidebarThreadVisible(runSummary, {})).toBe(true);
    expect(isSidebarThreadVisible(runSummary, { hideAutomationRunThreads: false })).toBe(true);
  });

  it("hides only unpinned automation-run threads when the option is on", () => {
    const options = { hideAutomationRunThreads: true };
    expect(isSidebarThreadVisible(runSummary, options)).toBe(false);
    expect(isSidebarThreadVisible(pinnedRunSummary, options)).toBe(true);
    expect(isSidebarThreadVisible(normalSummary, options)).toBe(true);
  });

  it("filters run threads out of the display and tree selectors", () => {
    const selectDisplay = createSidebarDisplayThreadsSelector({ hideAutomationRunThreads: true });
    const selectTree = createSidebarTreeThreadsSelector({ hideAutomationRunThreads: true });

    expect(selectDisplay(state).map((thread) => thread.id)).toEqual([threadIdB, threadIdC]);
    expect(selectTree(state).map((thread) => thread.id)).toEqual([threadIdB, threadIdC]);
  });

  it("keeps run threads in the selectors when the option is unset", () => {
    const selectDisplay = createSidebarDisplayThreadsSelector();
    expect(selectDisplay(state).map((thread) => thread.id)).toEqual([
      threadIdA,
      threadIdB,
      threadIdC,
    ]);
  });

  it("stays reference-stable while the underlying summaries do not change", () => {
    const selectDisplay = createSidebarDisplayThreadsSelector({ hideAutomationRunThreads: true });
    expect(selectDisplay(state)).toBe(selectDisplay(state));
  });
});

describe("createComposerThreadMentionSourcesSelector", () => {
  it("does not rescan summaries when only streaming detail changes", () => {
    const selectSources = createComposerThreadMentionSourcesSelector();
    const threadIds = [threadIdA];
    let summaryReads = 0;
    const summaryById = new Proxy(
      { [threadIdA]: summaryA },
      {
        get(target, property, receiver) {
          summaryReads += 1;
          return Reflect.get(target, property, receiver);
        },
      },
    );

    const before = selectSources(makeState({ threadIds, sidebarThreadSummaryById: summaryById }));
    const readsAfterFirstSelection = summaryReads;
    const after = selectSources(
      makeState({
        threadIds,
        sidebarThreadSummaryById: summaryById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
    expect(summaryReads).toBe(readsAfterFirstSelection);
  });
});

describe("createAllThreadsSelector", () => {
  it("preserves the untouched thread identity when another thread shell changes", () => {
    const selectThreads = createAllThreadsSelector();
    const threadIds = [threadIdA, threadIdB];
    const before = selectThreads(
      makeState({
        threadIds,
        threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
      }),
    );
    const after = selectThreads(
      makeState({
        threadIds,
        threadShellById: {
          [threadIdA]: { ...shellA, title: "renamed" },
          [threadIdB]: shellB,
        },
      }),
    );

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });
});

describe("createAllThreadsMessagelessSelector", () => {
  it("is vacuously true with no threads", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    expect(selectMessageless(makeState({}))).toBe(true);
  });

  it("is true when every thread has no message ids", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdA]: [] },
    });
    expect(selectMessageless(state)).toBe(true);
  });

  it("is false once any thread has a message", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      messageIdsByThreadId: { [threadIdB]: [messageId] },
    });
    expect(selectMessageless(state)).toBe(false);
  });
});

describe("thread shell route selectors", () => {
  it("resolve existence and project id without reading detail slices", () => {
    const state = makeState({
      threadIds: [threadIdA],
      threadShellById: { [threadIdA]: shellA },
    });
    Object.defineProperty(state, "messageIdsByThreadId", {
      get() {
        throw new Error("detail messages should not be read");
      },
    });

    expect(createThreadExistsSelector(threadIdA)(state)).toBe(true);
    expect(createThreadProjectIdSelector(threadIdA)(state)).toBe(projectId);
  });

  it("keeps workspace metadata stable while streaming messages change", () => {
    const selectWorkspaceMetadata = createThreadWorkspaceMetadataSelector(threadIdA);
    const threadIds = [threadIdA];
    const threadShellById = {
      [threadIdA]: {
        ...shellA,
        envMode: "worktree" as const,
        worktreePath: "/repo/.worktrees/feature",
      },
    };

    const before = selectWorkspaceMetadata(makeState({ threadIds, threadShellById }));
    const after = selectWorkspaceMetadata(
      makeState({
        threadIds,
        threadShellById,
        messageIdsByThreadId: { [threadIdA]: [messageId] },
      }),
    );

    expect(after).toBe(before);
    expect(after).toEqual({
      envMode: "worktree",
      worktreePath: "/repo/.worktrees/feature",
      workingDirectory: null,
    });
  });

  it("updates workspace metadata when a Studio working directory changes", () => {
    const selectWorkspaceMetadata = createThreadWorkspaceMetadataSelector(threadIdA);
    const before = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: {
          [threadIdA]: {
            ...shellA,
            envMode: "local",
            workingDirectory: "/repo/one",
          },
        },
      }),
    );
    const after = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: {
          [threadIdA]: {
            ...shellA,
            envMode: "local",
            workingDirectory: "/repo/two",
          },
        },
      }),
    );

    expect(after).not.toBe(before);
    expect(after).toEqual({
      envMode: "local",
      worktreePath: null,
      workingDirectory: "/repo/two",
    });
  });
});

describe("createProjectLastActivityAtSelector", () => {
  const otherProjectId = "project-2" as ProjectId;

  it("keeps the newest user message per project", () => {
    const selectActivity = createProjectLastActivityAtSelector();
    const activity = selectActivity(
      makeState({
        threadIds: [threadIdA, threadIdB],
        sidebarThreadSummaryById: {
          [threadIdA]: { ...summaryA, latestUserMessageAt: "2026-02-01T00:00:00.000Z" },
          [threadIdB]: {
            ...summaryA,
            id: threadIdB,
            latestUserMessageAt: "2026-03-01T00:00:00.000Z",
          },
        },
      }),
    );

    expect(activity.get(projectId)).toBe("2026-03-01T00:00:00.000Z");
  });

  it("falls back to the thread creation time when nothing was written yet", () => {
    const selectActivity = createProjectLastActivityAtSelector();
    const activity = selectActivity(
      makeState({
        threadIds: [threadIdA],
        sidebarThreadSummaryById: { [threadIdA]: summaryA },
      }),
    );

    expect(activity.get(projectId)).toBe("2026-01-01T00:00:00.000Z");
    expect(activity.has(otherProjectId)).toBe(false);
  });

  it("keeps a stable identity when the summaries change without moving activity", () => {
    const selectActivity = createProjectLastActivityAtSelector();
    const before = selectActivity(
      makeState({
        threadIds: [threadIdA],
        sidebarThreadSummaryById: { [threadIdA]: summaryA },
      }),
    );
    const after = selectActivity(
      makeState({
        threadIds: [threadIdA],
        sidebarThreadSummaryById: { [threadIdA]: { ...summaryA, title: "renamed" } },
      }),
    );

    expect(after).toBe(before);
  });
});
