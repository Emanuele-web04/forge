import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import type { SidebarThreadSummary, ThreadSession } from "../../types";
import {
  areKanbanComposerDraftSnapshotsEqual,
  buildKanbanComposerDraftSnapshot,
  buildKanbanBoard,
  deriveKanbanColumn,
  flattenProjectBoardForOverview,
  isKanbanDraftOnlyCard,
  kanbanDraftCardId,
  kanbanThreadCardId,
  orderDraftCards,
  reorderDraftCardIds,
  resolveDraftDropAction,
  resolveOptimisticDispatchOutcome,
  type BuildKanbanBoardInput,
  type KanbanCard,
  type KanbanOptimisticDispatchSnapshot,
} from "./kanban.logic";

function makeLatestTurn(
  overrides: Partial<NonNullable<SidebarThreadSummary["latestTurn"]>> = {},
): NonNullable<SidebarThreadSummary["latestTurn"]> {
  return {
    turnId: "turn-1" as never,
    state: "completed",
    assistantMessageId: null,
    requestedAt: "2026-03-09T10:00:00.000Z",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
    ...overrides,
  };
}

function makeSession(overrides: Partial<ThreadSession> = {}): ThreadSession {
  return {
    provider: "codex",
    status: "ready",
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
    orchestrationStatus: "ready",
    ...overrides,
  };
}

function makeSidebarThreadSummary(
  overrides: Partial<SidebarThreadSummary> = {},
): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Thread",
    modelSelection: {
      provider: "codex",
      model: "gpt-5.4",
    },
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    session: null,
    createdAt: "2026-03-09T10:00:00.000Z",
    updatedAt: "2026-03-09T10:00:00.000Z",
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
          {
            threadId: promotedId,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
          {
            threadId: localId,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:30:00.000Z",
            branch: null,
          },
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
          {
            threadId: ThreadId.makeUnsafe("thread-orphan"),
            projectId: ProjectId.makeUnsafe("project-unknown"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
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
        draftThreads: [
          {
            threadId: ThreadId.makeUnsafe("thread-empty"),
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
        ],
      }),
    );

    expect(board.projects[0]!.draft).toHaveLength(0);
  });

  it("keeps local drafts with attachment-only composer content", () => {
    const threadId = ThreadId.makeUnsafe("thread-image-only");
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [
          {
            threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
        ],
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
          {
            threadId: first,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
          {
            threadId: second,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T11:00:00.000Z",
            branch: null,
          },
          {
            threadId: newest,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T12:00:00.000Z",
            branch: null,
          },
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
    projectId: ProjectId.makeUnsafe("project-1"),
    title: "Fix the flaky reconnect test",
    provider: "cursor",
    baselineTurnId: null,
    droppedAtMs: Date.parse("2026-03-09T12:00:00.000Z"),
    ...overrides,
  });

  it("forces a dispatched draft thread into In Progress and suppresses its draft card", () => {
    const threadId = ThreadId.makeUnsafe("thread-1");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ id: threadId })],
        optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry() },
      }),
    );

    const project = board.projects[0]!;
    expect(project.draft).toHaveLength(0);
    expect(project.inProgress.map((card) => card.cardId)).toEqual([kanbanThreadCardId(threadId)]);
    const card = project.inProgress[0]!;
    expect(card.isOptimisticDispatch).toBe(true);
    expect(card.column).toBe("inProgress");
    expect(card.title).toBe("Thread");
    expect(card.draftPrompt).toBe("");
  });

  it("moves a settled thread's dispatched unsent prompt In Progress and hides the done duplicate", () => {
    const threadId = ThreadId.makeUnsafe("thread-done");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ id: threadId, latestTurn: makeLatestTurn() })],
        composerDraftByThreadId: {
          [threadId]: { prompt: "Follow up", hasAttachments: false, provider: null },
        },
        optimisticDispatchByThreadId: {
          [threadId]: makeOptimisticEntry({ baselineTurnId: "turn-1" }),
        },
      }),
    );

    const project = board.projects[0]!;
    expect(project.draft).toHaveLength(0);
    expect(project.done).toHaveLength(0);
    expect(project.inProgress.map((card) => card.cardId)).toEqual([kanbanThreadCardId(threadId)]);
    expect(project.inProgress[0]!.isOptimisticDispatch).toBe(true);
  });

  it("leaves naturally In Progress threads untouched by a stale entry", () => {
    const threadId = ThreadId.makeUnsafe("thread-live");
    const board = buildKanbanBoard(
      makeBoardInput({
        threads: [makeSidebarThreadSummary({ id: threadId, hasLiveTailWork: true })],
        optimisticDispatchByThreadId: { [threadId]: makeOptimisticEntry() },
      }),
    );

    const project = board.projects[0]!;
    expect(project.inProgress).toHaveLength(1);
    expect(project.inProgress[0]!.isOptimisticDispatch).toBe(false);
  });

  it("keeps a dispatched local draft visible after the composer prompt is cleared", () => {
    const threadId = ThreadId.makeUnsafe("thread-local");
    const board = buildKanbanBoard(
      makeBoardInput({
        draftThreads: [
          {
            threadId,
            projectId: ProjectId.makeUnsafe("project-1"),
            createdAt: "2026-03-09T10:00:00.000Z",
            branch: null,
          },
        ],
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

  it("settles when a turn other than the baseline appears", () => {
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({ latestTurn: makeLatestTurn() }),
      ),
    ).toBe("settled");
    expect(
      resolveOptimisticDispatchOutcome(
        entry("turn-1"),
        makeSidebarThreadSummary({ latestTurn: makeLatestTurn({ turnId: "turn-2" as never }) }),
      ),
    ).toBe("settled");
  });

  it("settles when the session is running even before a new turn registers", () => {
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({ status: "running", orchestrationStatus: "running" }),
        }),
      ),
    ).toBe("settled");
  });

  it("keeps watching through the connecting pre-init window", () => {
    // The early "starting" status must not settle the entry: provider init can
    // still fail, and the failure toast depends on the entry being alive.
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({ session: makeSession({ status: "connecting" }) }),
      ),
    ).toBe("pending");
  });

  it("stays pending while the thread still matches the dispatch-time baseline", () => {
    expect(resolveOptimisticDispatchOutcome(entry(null), makeSidebarThreadSummary())).toBe(
      "pending",
    );
    expect(
      resolveOptimisticDispatchOutcome(
        entry("turn-1"),
        makeSidebarThreadSummary({ latestTurn: makeLatestTurn() }),
      ),
    ).toBe("pending");
  });

  it("fails when the session errors at or after the drop without a turn", () => {
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({
            status: "error",
            orchestrationStatus: "error",
            updatedAt: "2026-03-09T12:00:00.000Z",
          }),
        }),
      ),
    ).toBe("failed");
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({
            status: "error",
            orchestrationStatus: "error",
            updatedAt: "2026-03-09T12:00:03.000Z",
          }),
        }),
      ),
    ).toBe("failed");
  });

  it("fails when the session closes after the drop without a turn", () => {
    // Manual stop or silent provider shutdown mid-init: the dispatch never ran.
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({
            status: "closed",
            orchestrationStatus: "stopped",
            updatedAt: "2026-03-09T12:00:02.000Z",
          }),
        }),
      ),
    ).toBe("failed");
  });

  it("ignores a stale closed session from before the drop", () => {
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({
            status: "closed",
            orchestrationStatus: "stopped",
            updatedAt: "2026-03-09T11:00:00.000Z",
          }),
        }),
      ),
    ).toBe("pending");
  });

  it("ignores a stale error from before the drop", () => {
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          session: makeSession({
            status: "error",
            orchestrationStatus: "error",
            updatedAt: "2026-03-09T11:59:00.000Z",
          }),
        }),
      ),
    ).toBe("pending");
  });

  it("prefers settled over failed when the turn ran before erroring", () => {
    // The turn existed (even if it errored): real runtime state owns the card.
    expect(
      resolveOptimisticDispatchOutcome(
        entry(null),
        makeSidebarThreadSummary({
          latestTurn: makeLatestTurn({ state: "error" }),
          session: makeSession({
            status: "error",
            orchestrationStatus: "error",
            updatedAt: "2026-03-09T12:00:01.000Z",
          }),
        }),
      ),
    ).toBe("settled");
  });
});

const makeComposerSnapshot = (prompt: string) => ({
  prompt,
  hasAttachments: false,
  provider: null,
});

describe("buildKanbanComposerDraftSnapshot", () => {
  it("ignores terminal contexts whose text is not available anymore", () => {
    const snapshot = buildKanbanComposerDraftSnapshot({
      prompt: "",
      files: [],
      images: [],
      persistedAttachments: [],
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId: ThreadId.makeUnsafe("thread-1"),
          terminalId: "terminal-1",
          terminalLabel: "Terminal",
          lineStart: 1,
          lineEnd: 2,
          text: "",
          createdAt: "2026-03-09T10:00:00.000Z",
        },
      ],
      assistantSelections: [],
      fileComments: [],
      workItemReferences: [],
      activeProvider: null,
    });

    expect(snapshot).toEqual({
      prompt: "",
      hasAttachments: false,
      provider: null,
    });
  });

  it("counts file attachments as pending draft attachments", () => {
    const snapshot = buildKanbanComposerDraftSnapshot({
      prompt: "",
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
      images: [],
      persistedAttachments: [],
      terminalContexts: [],
      assistantSelections: [],
      fileComments: [],
      workItemReferences: [],
      activeProvider: null,
    });

    expect(snapshot?.hasAttachments).toBe(true);
  });
});

describe("areKanbanComposerDraftSnapshotsEqual", () => {
  const snapshot = makeComposerSnapshot;

  it("treats value-equal maps as equal regardless of object identity", () => {
    expect(
      areKanbanComposerDraftSnapshotsEqual(
        { "thread-1": snapshot("hello"), "thread-2": snapshot("world") },
        { "thread-1": snapshot("hello"), "thread-2": snapshot("world") },
      ),
    ).toBe(true);
    expect(areKanbanComposerDraftSnapshotsEqual({}, {})).toBe(true);
  });

  it("detects differing prompts, flags, providers, and key sets", () => {
    expect(
      areKanbanComposerDraftSnapshotsEqual(
        { "thread-1": snapshot("hello") },
        { "thread-1": snapshot("hello!") },
      ),
    ).toBe(false);
    expect(
      areKanbanComposerDraftSnapshotsEqual(
        { "thread-1": snapshot("hello") },
        { "thread-1": { ...snapshot("hello"), hasAttachments: true } },
      ),
    ).toBe(false);
    expect(
      areKanbanComposerDraftSnapshotsEqual(
        { "thread-1": snapshot("hello") },
        { "thread-1": { ...snapshot("hello"), provider: "cursor" } },
      ),
    ).toBe(false);
    expect(
      areKanbanComposerDraftSnapshotsEqual(
        { "thread-1": snapshot("hello") },
        { "thread-2": snapshot("hello") },
      ),
    ).toBe(false);
    expect(areKanbanComposerDraftSnapshotsEqual({ "thread-1": snapshot("hello") }, {})).toBe(false);
  });
});

describe("orderDraftCards", () => {
  const makeCard = (cardId: string, sortTimestamp: number): KanbanCard => ({
    cardId,
    threadId: ThreadId.makeUnsafe(cardId),
    projectId: ProjectId.makeUnsafe("project-1"),
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
    projectId: ProjectId.makeUnsafe("project-1"),
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

describe("flattenProjectBoardForOverview", () => {
  it("orders cards In Progress, then Draft, then Done", () => {
    const card = (cardId: string, column: KanbanCard["column"]): KanbanCard => ({
      cardId,
      threadId: ThreadId.makeUnsafe(cardId),
      projectId: ProjectId.makeUnsafe("project-1"),
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

    const flattened = flattenProjectBoardForOverview({
      projectId: ProjectId.makeUnsafe("project-1"),
      projectName: "Synara",
      projectKind: "project",
      draft: [card("d", "draft")],
      inProgress: [card("w", "inProgress")],
      done: [card("x", "done")],
      totalCount: 3,
    });

    expect(flattened.map((entry) => entry.cardId)).toEqual(["w", "d", "x"]);
  });
});
