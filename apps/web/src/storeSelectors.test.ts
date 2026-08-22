import { describe, expect, it } from "vitest";

import type { MessageId, ProjectId, ThreadId } from "@synara/contracts";

import type { AppState } from "./store";
import {
  createAccountRateLimitThreadsSelector,
  createAllThreadsSelector,
  createAllThreadsMessagelessSelector,
  createComposerThreadMentionSourcesSelector,
  createLastActivityTimestampSelector,
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
  it("orders by threadIds, ignores streaming messages, and rebuilds when shells change", () => {
    const selectShells = createThreadShellsSelector();
    expect(
      selectShells(
        makeState({
          threadIds: [threadIdB, threadIdA],
          threadShellById: { [threadIdA]: shellA, [threadIdB]: shellB },
        }),
      ).map((shell) => shell.id),
    ).toEqual([threadIdB, threadIdA]);

    // The slices are shared by identity across both states so the derivation
    // cache (keyed on slice identity) can prove streaming changes don't churn.
    const threadIds = [threadIdA];
    const threadShellById = { [threadIdA]: shellA };
    const before = selectShells(makeState({ threadIds, threadShellById }));
    expect(
      selectShells(
        makeState({
          threadIds,
          threadShellById,
          messageIdsByThreadId: { [threadIdA]: [messageId] },
        }),
      ),
    ).toBe(before);

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
  const onlyRateLimit = {
    threadIds: [threadIdA],
    activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id] },
    activityByThreadId: { [threadIdA]: { [rateLimitActivity.id]: rateLimitActivity } },
  } as const;

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

  it("stays reference-stable through streaming deltas and non-rate-limit appends", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const before = selectRateLimitThreads(makeState(onlyRateLimit));

    expect(
      selectRateLimitThreads(
        makeState({ ...onlyRateLimit, messageIdsByThreadId: { [threadIdA]: [messageId] } }),
      ),
    ).toBe(before);
    expect(
      selectRateLimitThreads(
        makeState({
          ...onlyRateLimit,
          activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id, toolActivity.id] },
          activityByThreadId: {
            [threadIdA]: {
              [rateLimitActivity.id]: rateLimitActivity,
              [toolActivity.id]: toolActivity,
            },
          },
        }),
      ),
    ).toBe(before);
  });

  it("returns a new result when a rate-limit activity is appended, else the empty constant", () => {
    const selectRateLimitThreads = createAccountRateLimitThreadsSelector();
    const laterRateLimitActivity = makeActivity("activity-rate-2", "account.rate-limited");
    const before = selectRateLimitThreads(makeState(onlyRateLimit));

    const after = selectRateLimitThreads(
      makeState({
        ...onlyRateLimit,
        activityIdsByThreadId: { [threadIdA]: [rateLimitActivity.id, laterRateLimitActivity.id] },
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

  it("filters run threads out of the display and tree selectors only when the option is set", () => {
    const selectDisplay = createSidebarDisplayThreadsSelector({ hideAutomationRunThreads: true });
    const selectTree = createSidebarTreeThreadsSelector({ hideAutomationRunThreads: true });

    expect(selectDisplay(state).map((thread) => thread.id)).toEqual([threadIdB, threadIdC]);
    expect(selectTree(state).map((thread) => thread.id)).toEqual([threadIdB, threadIdC]);
    expect(createSidebarDisplayThreadsSelector()(state).map((thread) => thread.id)).toEqual([
      threadIdA,
      threadIdB,
      threadIdC,
    ]);
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
  it("is true until any thread has a message", () => {
    const selectMessageless = createAllThreadsMessagelessSelector();
    expect(selectMessageless(makeState({}))).toBe(true);
    expect(
      selectMessageless(
        makeState({
          threadIds: [threadIdA, threadIdB],
          messageIdsByThreadId: { [threadIdA]: [] },
        }),
      ),
    ).toBe(true);
    expect(
      selectMessageless(
        makeState({
          threadIds: [threadIdA, threadIdB],
          messageIdsByThreadId: { [threadIdB]: [messageId] },
        }),
      ),
    ).toBe(false);
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
    const shellWithWorkingDirectory = (workingDirectory: string) => ({
      [threadIdA]: {
        ...shellA,
        envMode: "local" as const,
        workingDirectory,
      },
    });
    const before = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: shellWithWorkingDirectory("/repo/one"),
      }),
    );
    const after = selectWorkspaceMetadata(
      makeState({
        threadIds: [threadIdA],
        threadShellById: shellWithWorkingDirectory("/repo/two"),
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

  it("keeps the newest user message per project, falling back to thread creation time", () => {
    const selectActivity = createProjectLastActivityAtSelector();
    const mixed = selectActivity(
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
    expect(mixed.get(projectId)).toBe("2026-03-01T00:00:00.000Z");

    const fallback = selectActivity(
      makeState({
        threadIds: [threadIdA],
        sidebarThreadSummaryById: { [threadIdA]: summaryA },
      }),
    );
    expect(fallback.get(projectId)).toBe("2026-01-01T00:00:00.000Z");
    expect(fallback.has(otherProjectId)).toBe(false);
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

describe("createLastActivityTimestampSelector", () => {
  const stamped = "2026-03-09T11:00:00.000Z";
  const withStamp = {
    threadIds: [threadIdA] as readonly ThreadId[],
    threadShellById: { [threadIdA]: { ...shellA, updatedAt: stamped } },
  };

  it("maps only shells that carry a durable stamp (sparse map, C1)", () => {
    const selectTimestamps = createLastActivityTimestampSelector();
    const state = makeState({
      threadIds: [threadIdA, threadIdB],
      threadShellById: {
        // Shell A has a durable stamp; shell B is present but stale/pruned.
        [threadIdA]: { ...shellA, updatedAt: stamped },
        [threadIdB]: { ...shellB },
      },
    });
    const result = selectTimestamps(state);
    expect(Object.keys(result)).toEqual([threadIdA]);
    expect(result[threadIdA]).toBe(Date.parse(stamped));
    // Absent shells must not be conflated with an explicit null.
    expect(threadIdB in result).toBe(false);
    expect(
      selectTimestamps(
        makeState({ threadIds: [threadIdA], threadShellById: { [threadIdA]: { ...shellA } } }),
      ),
    ).toEqual({});
  });

  it("keeps the previous result while neither streaming nor meta-only shell churn moves a stamp (F1)", () => {
    const selectTimestamps = createLastActivityTimestampSelector();
    const before = selectTimestamps(makeState(withStamp));

    expect(
      selectTimestamps(
        makeState({ ...withStamp, messageIdsByThreadId: { [threadIdA]: [messageId] } }),
      ),
    ).toBe(before);

    // A meta-only shell update (new object, same durable stamp) must not churn
    // the result — the fast path returns the previous object by reference (F1).
    const after = selectTimestamps(
      makeState({
        ...withStamp,
        threadShellById: { [threadIdA]: { ...shellA, updatedAt: stamped, title: "renamed" } },
      }),
    );
    expect(after).toBe(before);
    expect(after[threadIdA]).toBe(Date.parse(stamped));
  });
});
