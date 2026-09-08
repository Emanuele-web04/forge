import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import type { SidebarThreadSummary, ThreadSession } from "../../types";
import {
  areKanbanComposerDraftSnapshotsEqual,
  buildKanbanComposerDraftSnapshot,
  buildKanbanBoard,
  deriveKanbanCardAttention,
  deriveKanbanColumn,
  deriveKanbanColumnV2,
  isKanbanDraftOnlyCard,
  kanbanDraftCardId,
  kanbanThreadCardId,
  KANBAN_NEEDS_REVIEW_CAP,
  orderDraftCards,
  overviewVisibleKanbanCards,
  reorderDraftCardIds,
  refineAttentionFlagsForLivePr,
  resolveDraftDropAction,
  resolveOptimisticDispatchOutcome,
  resolveReviewFoldToggleLabel,
  shouldShowReviewFoldToggle,
  shouldToastForExpiredDispatch,
  type BuildKanbanBoardInput,
  type KanbanCard,
  type KanbanOptimisticDispatchSnapshot,
  type KanbanProjectBoard,
} from "./kanban.logic";

function makeLatestTurn(
  overrides: Partial<NonNullable<SidebarThreadSummary["latestTurn"]>> = {},
): NonNullable<SidebarThreadSummary["latestTurn"]> {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: T0,
    startedAt: T0,
    completedAt: "2026-03-09T10:05:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "ready",
    createdAt: T0,
    updatedAt: T0,
    orchestrationStatus: "ready",
    ...overrides,
  };
}

const T0 = "2026-03-09T10:00:00.000Z";
const PROJECT_1 = ProjectId.makeUnsafe("project-1");

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: PROJECT_1,
    title: "Thread",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: T0,
    updatedAt: T0,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

function makeBoardInput(overrides: Partial<BuildKanbanBoardInput> = {}): BuildKanbanBoardInput {
  return {
    projects: [{ id: ProjectId.makeUnsafe("project-1"), kind: "project", name: "Synara" }],
    threads: [],
    draftThreads: [],
    composerDraftByThreadId: {},
    draftOrderByProjectId: {},
    ...overrides,
  };
}

function makeDraftThread(
  threadId: ThreadId,
  overrides: Partial<BuildKanbanBoardInput["draftThreads"][number]> = {},
): BuildKanbanBoardInput["draftThreads"][number] {
  return {
    threadId,
    projectId: PROJECT_1,
    createdAt: T0,
    branch: null,
    ...overrides,
  };
}

describe("deriveKanbanColumn", () => {
  it("puts threads needing attention in progress", () => {
    expect(deriveKanbanColumn(makeSidebarThreadSummary({ hasPendingApprovals: true }))).toBe(
      "inProgress",
    );
    expect(deriveKanbanColumn(makeSidebarThreadSummary({ hasPendingUserInput: true }))).toBe(
      "inProgress",
    );
    expect(deriveKanbanColumn(makeSidebarThreadSummary({ hasLiveTailWork: true }))).toBe(
      "inProgress",
    );
  });

  it("treats a requested turn without startedAt as in progress", () => {
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({
          latestTurn: makeLatestTurn({ state: "running", startedAt: null, completedAt: null }),
        }),
      ),
    ).toBe("inProgress");
  });

  it("treats a live latest turn as in progress", () => {
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({
          latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
          session: makeSession({ status: "running", orchestrationStatus: "running" }),
        }),
      ),
    ).toBe("inProgress");
  });

  it("treats connecting sessions and running sessions without turns as in progress", () => {
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({ session: makeSession({ status: "connecting" }) }),
      ),
    ).toBe("inProgress");
    expect(
      deriveKanbanColumn(makeSidebarThreadSummary({ session: makeSession({ status: "running" }) })),
    ).toBe("inProgress");
  });

  it("puts threads that never ran a turn in draft", () => {
    expect(deriveKanbanColumn(makeSidebarThreadSummary())).toBe("draft");
  });

  it("ignores pending approvals/input once the session is dead", () => {
    // A crashed/closed session can never receive the answer; the request must
    // not pin the thread to In Progress forever.
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({
          hasPendingUserInput: true,
          latestTurn: makeLatestTurn(),
          session: makeSession({ status: "closed", orchestrationStatus: "stopped" }),
        }),
      ),
    ).toBe("done");
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({
          hasPendingApprovals: true,
          latestTurn: makeLatestTurn(),
          session: makeSession({ status: "error", orchestrationStatus: "error" }),
        }),
      ),
    ).toBe("done");
    // A live (or not-yet-known) session keeps the request actionable.
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({
          hasPendingUserInput: true,
          session: makeSession({ status: "running", orchestrationStatus: "running" }),
        }),
      ),
    ).toBe("inProgress");
    expect(
      deriveKanbanColumn(makeSidebarThreadSummary({ hasPendingUserInput: true, session: null })),
    ).toBe("inProgress");
  });

  it("puts settled threads in done regardless of outcome", () => {
    expect(deriveKanbanColumn(makeSidebarThreadSummary({ latestTurn: makeLatestTurn() }))).toBe(
      "done",
    );
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({ latestTurn: makeLatestTurn({ state: "interrupted" }) }),
      ),
    ).toBe("done");
    expect(
      deriveKanbanColumn(
        makeSidebarThreadSummary({ latestTurn: makeLatestTurn({ state: "error" }) }),
      ),
    ).toBe("done");
  });
});

describe("buildKanbanBoard", () => {
  it("groups thread cards per project with recency-sorted columns", () => {
    const projectId = ProjectId.makeUnsafe("project-1");
    const olderDone = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-old"),
      latestTurn: makeLatestTurn({ completedAt: "2026-03-09T09:00:00.000Z" }),
    });
    const newerDone = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-new"),
      latestTurn: makeLatestTurn({ completedAt: "2026-03-09T11:00:00.000Z" }),
    });
    const working = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-working"),
      hasLiveTailWork: true,
    });

    const board = buildKanbanBoard(makeBoardInput({ threads: [olderDone, newerDone, working] }));

    expect(board.projects).toHaveLength(1);
    const project = board.projects[0]!;
    expect(project.projectId).toBe(projectId);
    expect(project.inProgress.map((card) => card.threadId)).toEqual(["thread-working"]);
    expect(project.done.map((card) => card.threadId)).toEqual(["thread-new", "thread-old"]);
    expect(project.totalCount).toBe(3);
    expect(board.totalCount).toBe(3);
    expect(project.inProgress[0]?.cardId).toBe(kanbanThreadCardId(working.id));
  });

  it("folds aliased projects into the canonical board while cards keep their true projectId", () => {
    const canonicalId = ProjectId.makeUnsafe("project-1");
    const duplicateId = ProjectId.makeUnsafe("project-1-duplicate");
    const thread = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-aliased"),
      projectId: duplicateId,
      latestTurn: makeLatestTurn(),
    });

    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [thread],
        projectIdAliases: { [duplicateId]: canonicalId },
      }),
    );

    expect(board.projects).toHaveLength(1);
    const project = board.projects[0]!;
    expect(project.projectId).toBe(canonicalId);
    expect(project.done.map((card) => card.threadId)).toEqual(["thread-aliased"]);
    expect(project.done[0]?.projectId).toBe(duplicateId);
  });

  it("adds local draft threads and skips ones already promoted to real threads", () => {
    const promotedId = ThreadId.makeUnsafe("thread-promoted");
    const localId = ThreadId.makeUnsafe("thread-local");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ id: promotedId })],
        draftThreads: [
          makeDraftThread(promotedId),
          makeDraftThread(localId, { createdAt: "2026-03-09T10:30:00.000Z" }),
        ],
        composerDraftByThreadId: {
          [localId]: {
            prompt: "  Fix the flaky reconnect test  ",
            hasAttachments: false,
            provider: "claudeAgent",
          },
        },
      }),
    );

    const draftCards = board.projects[0]!.draft;
    expect(draftCards.map((card) => card.cardId)).toEqual([
      kanbanDraftCardId(localId),
      kanbanThreadCardId(promotedId),
    ]);
    const localCard = draftCards[0]!;
    expect(localCard.thread).toBeNull();
    expect(localCard.draftPrompt).toBe("Fix the flaky reconnect test");
    expect(localCard.title).toContain("Fix the flaky");
    expect(localCard.provider).toBe("claudeAgent");
  });

  it("surfaces an unsent prompt on a settled thread as an extra draft card", () => {
    const threadId = ThreadId.makeUnsafe("thread-done");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [
          makeSidebarThreadSummary({
            id: threadId,
            latestTurn: makeLatestTurn(),
          }),
        ],
        composerDraftByThreadId: {
          [threadId]: {
            prompt: "Follow up on the review notes",
            hasAttachments: false,
            provider: "cursor",
          },
        },
      }),
    );

    const project = board.projects[0]!;
    expect(project.done.map((card) => card.cardId)).toEqual([kanbanThreadCardId(threadId)]);
    expect(project.draft.map((card) => card.cardId)).toEqual([kanbanDraftCardId(threadId)]);
    const draftCard = project.draft[0]!;
    expect(draftCard.threadId).toBe(threadId);
    expect(draftCard.thread).not.toBeNull();
    expect(draftCard.provider).toBe("cursor");
    expect(resolveDraftDropAction(draftCard)).toBe("dispatch");
  });

  it("distinguishes prompt draft cards from durable thread cards", () => {
    const threadId = ThreadId.makeUnsafe("thread-draft-identity");

    expect(
      isKanbanDraftOnlyCard({
        cardId: kanbanDraftCardId(threadId),
        threadId,
        column: "draft",
      }),
    ).toBe(true);
    expect(
      isKanbanDraftOnlyCard({
        cardId: kanbanThreadCardId(threadId),
        threadId,
        column: "draft",
      }),
    ).toBe(false);
    expect(
      isKanbanDraftOnlyCard({
        cardId: kanbanDraftCardId(threadId),
        threadId,
        column: "inProgress",
      }),
    ).toBe(false);
  });

  it("skips threads and drafts that belong to unknown projects", () => {
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ projectId: ProjectId.makeUnsafe("project-unknown") })],
        draftThreads: [
          makeDraftThread(ThreadId.makeUnsafe("thread-orphan"), {
            projectId: ProjectId.makeUnsafe("project-unknown"),
          }),
        ],
        composerDraftByThreadId: {
          "thread-orphan": { prompt: "orphan", hasAttachments: false, provider: null },
        },
      }),
    );

    expect(board.totalCount).toBe(0);
    expect(board.projects[0]!.totalCount).toBe(0);
  });

  it("skips local drafts whose composer is empty", () => {
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [makeDraftThread(ThreadId.makeUnsafe("thread-empty"))],
      }),
    );

    expect(board.projects[0]!.draft).toHaveLength(0);
  });

  it("keeps local drafts with attachment-only composer content", () => {
    const threadId = ThreadId.makeUnsafe("thread-image-only");
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [makeDraftThread(threadId)],
        composerDraftByThreadId: {
          [threadId]: { prompt: "", hasAttachments: true, provider: "cursor" },
        },
      }),
    );

    const draftCard = board.projects[0]!.draft[0]!;
    expect(draftCard.title).toBe("Attached references");
    expect(draftCard.draftHasAttachments).toBe(true);
    expect(draftCard.provider).toBe("cursor");
    expect(resolveDraftDropAction(draftCard)).toBe("dispatch");
  });

  it("applies the persisted manual draft order ahead of recency", () => {
    const first = ThreadId.makeUnsafe("thread-a");
    const second = ThreadId.makeUnsafe("thread-b");
    const newest = ThreadId.makeUnsafe("thread-c");
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [
          makeDraftThread(first),
          makeDraftThread(second, { createdAt: "2026-03-09T11:00:00.000Z" }),
          makeDraftThread(newest, { createdAt: "2026-03-09T12:00:00.000Z" }),
        ],
        composerDraftByThreadId: {
          [first]: { prompt: "a", hasAttachments: false, provider: null },
          [second]: { prompt: "b", hasAttachments: false, provider: null },
          [newest]: { prompt: "c", hasAttachments: false, provider: null },
        },
        draftOrderByProjectId: {
          "project-1": [kanbanDraftCardId(first), kanbanDraftCardId(second)],
        },
      }),
    );

    expect(board.projects[0]!.draft.map((card) => card.cardId)).toEqual([
      kanbanDraftCardId(first),
      kanbanDraftCardId(second),
      kanbanDraftCardId(newest),
    ]);
  });
});

describe("buildKanbanBoard optimistic dispatch", () => {
  const makeOptimisticEntry = (
    overrides: Partial<KanbanOptimisticDispatchSnapshot> = {},
  ): KanbanOptimisticDispatchSnapshot => ({
    projectId: PROJECT_1,
    title: "Fix the flaky reconnect test",
    provider: "cursor",
    baselineTurnId: null,
    droppedAtMs: Date.parse("2026-03-09T12:00:00.000Z"),
    ...overrides,
  });

  // A dispatched drop renders its thread In Progress ahead of runtime state and
  // suppresses the draft/done duplicates; a thread that is already naturally
  // In Progress is left untouched by a stale entry.
  it.each([
    {
      name: "draft thread",
      input: (threadId: ThreadId): Partial<BuildKanbanBoardInput> => ({
        threads: [makeSidebarThreadSummary({ id: threadId })],
      }),
      suppressed: ["draft"],
      title: "Thread",
      cardIdOf: kanbanThreadCardId,
    },
    {
      name: "settled thread with an unsent prompt",
      input: (threadId: ThreadId): Partial<BuildKanbanBoardInput> => ({
        threads: [makeSidebarThreadSummary({ id: threadId, latestTurn: makeLatestTurn() })],
        composerDraftByThreadId: {
          [threadId]: { prompt: "Follow up", hasAttachments: false, provider: null },
        },
      }),
      suppressed: ["draft", "done"],
      entryOverrides: { baselineTurnId: "turn-1" },
      title: "Thread",
      cardIdOf: kanbanThreadCardId,
    },
    {
      name: "local draft",
      input: (threadId: ThreadId): Partial<BuildKanbanBoardInput> => ({
        draftThreads: [makeDraftThread(threadId)],
      }),
      suppressed: ["draft"],
      title: "Fix the flaky reconnect test",
      cardIdOf: kanbanDraftCardId,
    },
  ] as const)(
    "forces a dispatched $name card In Progress behind the optimistic overlay",
    ({ name, input, suppressed, entryOverrides, title, cardIdOf }) => {
      const threadId = ThreadId.makeUnsafe(`thread-${name.replace(/ /g, "-")}`);
      const project = buildKanbanBoard(
        makeBoardInput({
          ...input(threadId),
          optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry(entryOverrides) },
        }),
      ).projects[0]!;
      for (const column of suppressed) {
        expect(project[column as "draft" | "done"]).toHaveLength(0);
      }
      expect(project.inProgress.map((card) => card.cardId)).toEqual([cardIdOf(threadId)]);
      expect(project.inProgress[0]!.isOptimisticDispatch).toBe(true);
      expect(project.inProgress[0]!.title).toBe(title);
    },
  );

  it("leaves naturally In Progress threads untouched by a stale entry", () => {
    const threadId = ThreadId.makeUnsafe("thread-live");
    const project = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ id: threadId, hasLiveTailWork: true })],
        optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry() },
      }),
    ).projects[0]!;

    expect(project.inProgress).toHaveLength(1);
    expect(project.inProgress[0]!.isOptimisticDispatch).toBe(false);
  });

  it("keeps a dispatched local draft visible after the composer prompt is cleared", () => {
    const threadId = ThreadId.makeUnsafe("thread-local");
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [makeDraftThread(threadId)],
        optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry() },
      }),
    );

    const project = board.projects[0]!;
    expect(project.draft).toHaveLength(0);
    expect(project.inProgress).toHaveLength(1);
    const card = project.inProgress[0]!;
    expect(card.isOptimisticDispatch).toBe(true);
    // The composer prompt is gone, so the title falls back to the dispatch snapshot.
    expect(card.title).toBe("Fix the flaky reconnect test");
  });

  it("synthesizes a card during the promotion gap when neither thread nor draft exists", () => {
    const threadId = ThreadId.makeUnsafe("thread-promoting");
    const board = buildKanbanBoard(
      makeBoardInput({
        optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry() },
      }),
    );

    const project = board.projects[0]!;
    expect(project.inProgress.map((card) => card.cardId)).toEqual([kanbanThreadCardId(threadId)]);
    const card = project.inProgress[0]!;
    expect(card.isOptimisticDispatch).toBe(true);
    expect(card.title).toBe("Fix the flaky reconnect test");
    expect(card.provider).toBe("cursor");
    expect(card.thread).toBeNull();
  });

  it("skips synthesized cards for unknown projects", () => {
    const board = buildKanbanBoard(
      makeBoardInput({
        optimisticDispatchByThreadId: {
          "thread-orphan": makeOptimisticEntry({
            projectId: ProjectId.makeUnsafe("project-unknown"),
          }),
        },
      }),
    );

    expect(board.totalCount).toBe(0);
  });

  it("sorts fresh optimistic cards ahead of older In Progress work", () => {
    const optimisticId = ThreadId.makeUnsafe("thread-optimistic");
    const liveId = ThreadId.makeUnsafe("thread-live");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [
          makeSidebarThreadSummary({ id: optimisticId }),
          makeSidebarThreadSummary({
            id: liveId,
            hasLiveTailWork: true,
            latestTurn: makeLatestTurn({
              state: "running",
              startedAt: "2026-03-09T11:00:00.000Z",
              completedAt: null,
            }),
          }),
        ],
        optimisticDispatchByThreadId: { [optimisticId]: makeOptimisticEntry() },
      }),
    );

    expect(board.projects[0]!.inProgress.map((card) => card.threadId)).toEqual([
      optimisticId,
      liveId,
    ]);
  });
});

describe("resolveOptimisticDispatchOutcome", () => {
  const DROPPED_AT_MS = Date.parse("2026-03-09T12:00:00.000Z");
  const entry = (baselineTurnId: string | null) => ({ baselineTurnId, droppedAtMs: DROPPED_AT_MS });
  const outcome = (baselineTurnId: string | null, overrides: Partial<SidebarThreadSummary>) =>
    resolveOptimisticDispatchOutcome(entry(baselineTurnId), makeSidebarThreadSummary(overrides));

  it.each([
    {
      name: "a turn other than the baseline appears",
      baseline: null as string | null,
      thread: { latestTurn: makeLatestTurn() },
      outcome: "settled",
    },
    {
      name: "the baseline turn was replaced",
      baseline: "turn-1",
      thread: { latestTurn: makeLatestTurn({ turnId: "turn-2" as never }) },
      outcome: "settled",
    },
    {
      name: "the session runs before a new turn registers",
      baseline: null,
      thread: { session: makeSession({ status: "running", orchestrationStatus: "running" }) },
      outcome: "settled",
    },
    {
      name: "the connecting pre-init window is still live",
      baseline: null,
      thread: { session: makeSession({ status: "connecting" }) },
      outcome: "pending",
    },
    {
      name: "the dispatch-time baseline still matches",
      baseline: null,
      thread: {},
      outcome: "pending",
    },
    {
      name: "the baseline turn has not changed",
      baseline: "turn-1",
      thread: { latestTurn: makeLatestTurn() },
      outcome: "pending",
    },
  ] as const)("settles to $outcome when $name", ({ baseline, thread, outcome: expected }) => {
    expect(outcome(baseline, thread as Partial<SidebarThreadSummary>)).toBe(expected);
  });

  // Manual stop or silent provider shutdown mid-init fails the dispatch; a
  // terminal state from before the drop must not revert a fresh dispatch.
  it.each([
    {
      status: "error",
      orchestrationStatus: "error",
      at: "2026-03-09T12:00:00.000Z",
      expected: "failed",
    },
    {
      status: "error",
      orchestrationStatus: "error",
      at: "2026-03-09T12:00:03.000Z",
      expected: "failed",
    },
    {
      status: "closed",
      orchestrationStatus: "stopped",
      at: "2026-03-09T12:00:02.000Z",
      expected: "failed",
    },
    {
      status: "closed",
      orchestrationStatus: "stopped",
      at: "2026-03-09T11:00:00.000Z",
      expected: "pending",
    },
    {
      status: "error",
      orchestrationStatus: "error",
      at: "2026-03-09T11:59:00.000Z",
      expected: "pending",
    },
  ] as const)(
    "resolves a $status session ending at $at to $expected",
    ({ status, orchestrationStatus, at, expected }) => {
      expect(
        outcome(null, {
          session: makeSession({ status, orchestrationStatus, updatedAt: at }),
        }),
      ).toBe(expected);
    },
  );

  it("prefers settled over failed when the turn ran before erroring", () => {
    // The turn existed (even if it errored): real runtime state owns the card.
    expect(
      outcome(null, {
        latestTurn: makeLatestTurn({ state: "error" }),
        session: makeSession({ status: "error", orchestrationStatus: "error" }),
      }),
    ).toBe("settled");
  });
});

const makeComposerSnapshot = (prompt: string) => ({
  prompt,
  hasAttachments: false,
  provider: null,
});

const makeDraftSource = (
  overrides: Partial<Parameters<typeof buildKanbanComposerDraftSnapshot>[0]> = {},
) => ({
  prompt: "",
  files: [],
  images: [],
  persistedAttachments: [],
  terminalContexts: [],
  assistantSelections: [],
  fileComments: [],
  activeProvider: null,
  ...overrides,
});

describe("buildKanbanComposerDraftSnapshot", () => {
  it("ignores terminal contexts whose text is not available anymore", () => {
    const snapshot = buildKanbanComposerDraftSnapshot(
      makeDraftSource({
        terminalContexts: [
          {
            id: "ctx-expired",
            threadId: ThreadId.makeUnsafe("thread-1"),
            terminalId: "terminal-1",
            terminalLabel: "Terminal",
            lineStart: 1,
            lineEnd: 2,
            text: "",
            createdAt: T0,
          },
        ],
      }),
    );

    expect(snapshot).toEqual(makeComposerSnapshot(""));
  });

  it("counts file attachments as pending draft attachments", () => {
    const snapshot = buildKanbanComposerDraftSnapshot(
      makeDraftSource({
        files: [
          {
            type: "file",
            id: "file-1",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
            file: new File(["hello"], "notes.txt", { type: "text/plain" }),
          },
        ],
      }),
    );

    expect(snapshot?.hasAttachments).toBe(true);
  });
});

describe("areKanbanComposerDraftSnapshotsEqual", () => {
  const snapshot = makeComposerSnapshot;

  it.each([
    { left: {}, right: {}, equal: true },
    {
      left: { "thread-1": snapshot("hello"), "thread-2": snapshot("world") },
      right: { "thread-1": snapshot("hello"), "thread-2": snapshot("world") },
      equal: true,
    },
    {
      left: { "thread-1": snapshot("hello") },
      right: { "thread-1": snapshot("hello!") },
      equal: false,
    },
    {
      left: { "thread-1": snapshot("hello") },
      right: { "thread-1": { ...snapshot("hello"), hasAttachments: true } },
      equal: false,
    },
    {
      left: { "thread-1": snapshot("hello") },
      right: { "thread-1": { ...snapshot("hello"), provider: "cursor" } },
      equal: false,
    },
    {
      left: { "thread-1": snapshot("hello") },
      right: { "thread-2": snapshot("hello") },
      equal: false,
    },
    { left: { "thread-1": snapshot("hello") }, right: {}, equal: false },
  ] as const)("compares $left vs $right to $equal", ({ left, right, equal }) => {
    expect(areKanbanComposerDraftSnapshotsEqual(left, right)).toBe(equal);
  });
});

describe("orderDraftCards", () => {
  const makeCard = (cardId: string, sortTimestamp: number): KanbanCard => ({
    cardId,
    threadId: ThreadId.makeUnsafe(cardId),
    projectId: PROJECT_1,
    column: "draft",
    title: cardId,
    provider: null,
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp,
    timestamp: null,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  });

  it("keeps recency order when no manual order exists", () => {
    const ordered = orderDraftCards([makeCard("a", 1), makeCard("b", 3), makeCard("c", 2)], []);
    expect(ordered.map((card) => card.cardId)).toEqual(["b", "c", "a"]);
  });

  it("keeps unknown cards in recency order behind manually ordered ones", () => {
    const ordered = orderDraftCards(
      [makeCard("a", 1), makeCard("b", 3), makeCard("c", 2), makeCard("d", 4)],
      ["c", "a"],
    );
    expect(ordered.map((card) => card.cardId)).toEqual(["c", "a", "d", "b"]);
  });
});

describe("reorderDraftCardIds", () => {
  it("moves the active card to the position of the card it was dropped over", () => {
    expect(reorderDraftCardIds(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
    expect(reorderDraftCardIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("returns null when nothing moved or ids are unknown", () => {
    expect(reorderDraftCardIds(["a", "b"], "a", "a")).toBeNull();
    expect(reorderDraftCardIds(["a", "b"], "missing", "a")).toBeNull();
  });
});

describe("resolveDraftDropAction", () => {
  const baseCard: KanbanCard = {
    cardId: "draft:thread-1",
    threadId: ThreadId.makeUnsafe("thread-1"),
    projectId: PROJECT_1,
    column: "draft",
    title: "Draft",
    provider: null,
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "Ship it",
    draftHasAttachments: false,
    sortTimestamp: 0,
    timestamp: null,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  };

  it("dispatches drafts with a sendable prompt", () => {
    expect(resolveDraftDropAction(baseCard)).toBe("dispatch");
  });

  it("falls back to opening the chat when the prompt is empty", () => {
    expect(resolveDraftDropAction({ ...baseCard, draftPrompt: "" })).toBe("open-thread");
    expect(resolveDraftDropAction({ ...baseCard, column: "done" })).toBe("open-thread");
  });

  it("dispatches drafts with attachments through the shared composer payload", () => {
    expect(
      resolveDraftDropAction({ ...baseCard, draftPrompt: "", draftHasAttachments: true }),
    ).toBe("dispatch");
  });

  it("opens the chat for pending worktree drafts so the composer owns setup", () => {
    expect(resolveDraftDropAction({ ...baseCard, envMode: "worktree", worktreePath: null })).toBe(
      "open-thread",
    );
    expect(
      resolveDraftDropAction({
        ...baseCard,
        envMode: "worktree",
        worktreePath: "/tmp/synara-worktree",
      }),
    ).toBe("dispatch");
  });
});

describe("overviewVisibleKanbanCards", () => {
  const card = (cardId: string, column: KanbanCard["column"]): KanbanCard => ({
    cardId,
    threadId: ThreadId.makeUnsafe(cardId),
    projectId: PROJECT_1,
    column,
    title: cardId,
    provider: null,
    isTerminal: false,
    branch: null,
    envMode: null,
    worktreePath: null,
    thread: null,
    draftPrompt: "",
    draftHasAttachments: false,
    sortTimestamp: 0,
    timestamp: null,
    activeWorkStartedAt: null,
    isOptimisticDispatch: false,
  });
  const board = (
    columns: Partial<Pick<KanbanProjectBoard, "draft" | "inProgress" | "awaitingYou" | "done">>,
  ) => {
    const draft = columns.draft ?? [];
    const inProgress = columns.inProgress ?? [];
    const awaitingYou = columns.awaitingYou ?? [];
    const done = columns.done ?? [];
    return {
      projectId: PROJECT_1,
      projectName: "Synara",
      projectKind: "project" as const,
      draft,
      inProgress,
      awaitingYou,
      done,
      totalCount: draft.length + inProgress.length + awaitingYou.length + done.length,
      hiddenCount: 0,
    };
  };

  it("caps each column before flattening and reports the folded remainder (H3)", () => {
    const inProgress = Array.from({ length: 25 }, (_, index) => card(`w-${index}`, "inProgress"));
    const done = Array.from({ length: 25 }, (_, index) => card(`d-${index}`, "done"));
    const { visibleCards, hiddenCount } = overviewVisibleKanbanCards(board({ inProgress, done }));

    // Per-column cap: 20 each, so no In Progress card is pushed off the window
    // by the Done tail — the attention-first contract of the overview.
    expect(visibleCards).toHaveLength(40);
    expect(hiddenCount).toBe(10);
    expect(visibleCards.slice(0, 20).map((entry) => entry.cardId)[0]).toBe("w-0");
    expect(visibleCards.at(-1)?.cardId).toBe("d-19");
  });

  it("routes Awaiting you after In Progress in v2 overview order", () => {
    const boardData = board({
      inProgress: [card("w", "inProgress")],
      awaitingYou: [card("a", "awaitingYou")],
      draft: [card("s", "draft")],
      done: [card("x", "done")],
    });
    const { visibleCards } = overviewVisibleKanbanCards(boardData, true);

    expect(visibleCards.map((entry) => entry.cardId)).toEqual(["w", "a", "s", "x"]);
  });

  it("shows every card when the overview cap is not reached", () => {
    const { visibleCards, hiddenCount } = overviewVisibleKanbanCards(
      board({ inProgress: [card("w", "inProgress")] }),
    );

    expect(visibleCards.map((entry) => entry.cardId)).toEqual(["w"]);
    expect(hiddenCount).toBe(0);
  });

  it("caps only the overflowing columns in v2 routing, not the whole project", () => {
    const awaitingYou = Array.from({ length: 30 }, (_, index) => card(`a-${index}`, "awaitingYou"));
    const { visibleCards, hiddenCount } = overviewVisibleKanbanCards(
      board({ awaitingYou, done: [card("x", "done")] }),
      true,
    );

    expect(visibleCards).toHaveLength(21);
    expect(hiddenCount).toBe(10);
    expect(visibleCards.at(-1)?.cardId).toBe("x");
  });
});

const FROZEN_NOW_MS = Date.parse("2026-03-09T12:00:00.000Z");
const FROZEN_NOW_ISO = new Date(FROZEN_NOW_MS).toISOString();

describe("deriveKanbanColumnV2 (web adapter)", () => {
  // The adapter projects the web summary into the shared derivation with the
  // board clock; a fresh heartbeat keeps live work In Progress (a stale one
  // ages into stuck/awaitingYou instead), and the adapter reads the shared
  // `orchestrationStatus` union, not the legacy phase.
  it.each([
    {
      name: "pending approval under a live session",
      thread: { hasPendingApprovals: true, latestTurn: { state: "running" } },
      expected: "awaitingYou",
    },
    { name: "settled thread", thread: { latestTurn: { state: "completed" } }, expected: "done" },
    { name: "bare thread", thread: {}, expected: "draft" },
    {
      name: "live-tail work with a fresh heartbeat",
      thread: {
        hasLiveTailWork: true,
        session: { status: "running", orchestrationStatus: "running" },
      },
      expected: "inProgress",
    },
    {
      name: "connecting phase mapped to the shared starting label",
      thread: { session: { status: "connecting", orchestrationStatus: "starting" } },
      expected: "inProgress",
    },
    {
      name: "dead-session pending falls through to done",
      thread: {
        hasPendingUserInput: true,
        latestTurn: { state: "completed" },
        session: { status: "closed", orchestrationStatus: "stopped" },
      },
      expected: "done",
    },
  ] as const)("derives $expected for $name", ({ thread, expected }) => {
    const summary = makeSidebarThreadSummary({
      ...thread,
      latestTurn:
        "latestTurn" in thread && thread.latestTurn
          ? makeLatestTurn({
              state: thread.latestTurn.state,
              completedAt: thread.latestTurn.state === "running" ? null : FROZEN_NOW_ISO,
            })
          : null,
      session:
        "session" in thread && thread.session
          ? makeSession({ ...thread.session, updatedAt: FROZEN_NOW_ISO })
          : null,
    } as Partial<SidebarThreadSummary>);
    expect(deriveKanbanColumnV2(summary, FROZEN_NOW_MS)).toBe(expected);
  });
});

describe("deriveKanbanCardAttention", () => {
  it.each([
    {
      name: "settled card",
      thread: { latestTurn: { state: "completed" }, session: { orchestrationStatus: "ready" } },
      expected: [],
    },
    {
      name: "errored session",
      thread: {
        latestTurn: { state: "error" },
        session: { status: "error", orchestrationStatus: "error", lastError: "boom" },
      },
      expected: ["failed"],
    },
    {
      name: "open PR from the caller",
      thread: { latestTurn: { state: "completed" }, session: { orchestrationStatus: "ready" } },
      needsReview: true,
      expected: ["needs-review"],
    },
  ] as const)("maps $name to $expected", ({ thread, needsReview, expected }) => {
    const attention = deriveKanbanCardAttention(
      makeSidebarThreadSummary({
        latestTurn:
          "latestTurn" in thread && thread.latestTurn
            ? makeLatestTurn({ state: thread.latestTurn.state })
            : null,
        session:
          "session" in thread && thread.session
            ? makeSession({ ...thread.session, updatedAt: FROZEN_NOW_ISO })
            : null,
      } as Partial<SidebarThreadSummary>),
      { now: FROZEN_NOW_MS, ...(needsReview ? { needsReview } : {}) },
    );
    expect(attention).toEqual(expected);
  });
});

describe("buildKanbanBoard v2 mode", () => {
  const v2Options = (overrides: Partial<Parameters<typeof buildKanbanBoard>[1]> = {}) => ({
    now: FROZEN_NOW_MS,
    ...overrides,
  });
  const liveSession = () =>
    makeSession({ status: "running", orchestrationStatus: "running", updatedAt: FROZEN_NOW_ISO });
  const makeOpenPrThread = (id: string, index = 0) =>
    makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe(id),
      latestTurn: makeLatestTurn(),
      lastKnownPr: {
        number: index + 1,
        title: "Open PR",
        url: "https://example.com/pr",
        baseBranch: "main",
        headBranch: `fix-${index}`,
        state: "open",
      },
    });
  const reviewMapFor = (threads: ReadonlyArray<SidebarThreadSummary>) => {
    const map: Record<string, boolean> = {};
    for (const thread of threads) map[thread.id] = true;
    return map;
  };

  it("buckets awaitingYou cards separately from inProgress", () => {
    const awaiting = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-awaited"),
      hasPendingApprovals: true,
      latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
      session: liveSession(),
    });
    const running = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-running"),
      hasLiveTailWork: true,
      latestTurn: makeLatestTurn({ state: "running", completedAt: null }),
      session: liveSession(),
    });
    const board = buildKanbanBoard(makeBoardInput({ threads: [awaiting, running] }), v2Options());
    expect(board.projects[0]!.inProgress.map((card) => card.threadId)).toEqual(["thread-running"]);
    expect(board.projects[0]!.awaitingYou.map((card) => card.threadId)).toEqual(["thread-awaited"]);
  });

  it("fills attention on thread cards in v2 mode", () => {
    const failed = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-failed"),
      latestTurn: makeLatestTurn({ state: "error" }),
      session: makeSession({
        status: "error",
        orchestrationStatus: "error",
        lastError: "x",
        updatedAt: FROZEN_NOW_ISO,
      }),
    });
    const board = buildKanbanBoard(makeBoardInput({ threads: [failed] }), v2Options());
    const card = board.projects[0]!.awaitingYou[0]!;
    expect(card.attention).toContain("failed");
  });

  it("leaves classic cards with no attention fields", () => {
    const failed = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-failed"),
      latestTurn: makeLatestTurn({ state: "error" }),
      session: makeSession({ status: "error", orchestrationStatus: "error" }),
    });
    const board = buildKanbanBoard(makeBoardInput({ threads: [failed] }));
    const doneCard = board.projects[0]!.done[0]!;
    expect(doneCard.attention).toBeUndefined();
  });

  it("applies the needs-review filter in v2 mode", () => {
    const noReview = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-noreview"),
      latestTurn: makeLatestTurn(),
    });
    const withReview = makeSidebarThreadSummary({
      id: ThreadId.makeUnsafe("thread-review"),
      latestTurn: makeLatestTurn(),
      lastKnownPr: {
        number: 1,
        title: "Open PR",
        url: "https://example.com/pr/1",
        baseBranch: "main",
        headBranch: "fix",
        state: "open",
      },
    });
    const filtered = buildKanbanBoard(
      makeBoardInput({ threads: [noReview, withReview] }),
      v2Options({
        needsReviewByThreadId: { "thread-review": true },
        isNeedsReviewActive: true,
      }),
    );
    const project = filtered.projects[0]!;
    expect(project.done.map((card) => card.threadId)).toEqual(["thread-review"]);
    expect(project.totalCount).toBe(1);
    expect(project.done[0]!.needsReview).toBe(true);
  });

  it.each([
    { uncapped: false, extra: 8, rendered: KANBAN_NEEDS_REVIEW_CAP, hidden: 8 },
    { uncapped: true, extra: 5, rendered: KANBAN_NEEDS_REVIEW_CAP + 5, hidden: 0 },
  ])(
    "$renders done rows with hidden=$hidden when uncapped=$uncapped (H1)",
    ({ uncapped, extra, rendered, hidden }) => {
      const reviewThreads = Array.from({ length: KANBAN_NEEDS_REVIEW_CAP + extra }, (_, index) =>
        makeOpenPrThread(`thread-review-${index}`, index),
      );
      const project = buildKanbanBoard(
        makeBoardInput({ threads: reviewThreads }),
        v2Options({
          needsReviewByThreadId: reviewMapFor(reviewThreads),
          isNeedsReviewActive: true,
          uncapped,
        }),
      ).projects[0]!;
      expect(project.done).toHaveLength(rendered);
      // The header count stays the pre-cap total either way; the fold is
      // reported for the reveal affordance.
      expect(project.totalCount).toBe(KANBAN_NEEDS_REVIEW_CAP + extra);
      expect(project.hiddenCount).toBe(hidden);
    },
  );

  it("keeps all cards when the needs-review filter is off", () => {
    const board = buildKanbanBoard(
      makeBoardInput({ threads: [makeSidebarThreadSummary({ latestTurn: makeLatestTurn() })] }),
      v2Options(),
    );
    expect(board.projects[0]!.done).toHaveLength(1);
  });
});

describe("refineAttentionFlagsForLivePr", () => {
  // Operates on raw flag identifiers; display copy maps after refinement.
  it.each([
    { flags: undefined as readonly string[] | undefined, live: undefined, out: [] },
    { flags: [], live: "open", out: [] },
    { flags: ["failed", "needs-review"], live: undefined, out: ["failed", "needs-review"] },
    { flags: ["failed", "needs-review"], live: "open", out: ["failed", "needs-review"] },
    { flags: ["failed", "needs-review"], live: "merged", out: ["failed"] },
    { flags: ["failed", "needs-review"], live: null, out: ["failed"] },
    { flags: ["needs-review"], live: "closed", out: [] },
  ] as const)("keeps $flags with live=$live -> $out", ({ flags, live, out }) => {
    expect(
      refineAttentionFlagsForLivePr(
        flags as Parameters<typeof refineAttentionFlagsForLivePr>[0],
        live as "open" | "closed" | "merged" | null | undefined,
      ),
    ).toEqual(out);
  });
});

describe("shouldToastForExpiredDispatch (H5)", () => {
  it.each([
    { name: "thread left the display set", thread: undefined, toast: false },
    {
      name: "live-tail work still in progress",
      thread: makeSidebarThreadSummary({ hasLiveTailWork: true }),
      toast: false,
    },
    {
      name: "running session still in progress",
      thread: makeSidebarThreadSummary({
        session: makeSession({ status: "running", orchestrationStatus: "running" }),
      }),
      toast: false,
    },
    {
      name: "reverted to done",
      thread: makeSidebarThreadSummary({ latestTurn: makeLatestTurn() }),
      toast: true,
    },
    { name: "bare draft", thread: makeSidebarThreadSummary(), toast: true },
  ] as const)("toasts=$toast for $name", ({ thread, toast }) => {
    expect(shouldToastForExpiredDispatch(thread)).toBe(toast);
  });
});
