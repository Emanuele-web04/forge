import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@synara/contracts";

import type { SidebarThreadSummary, ThreadSession } from "../types";
import { resolveThreadProjectLabel } from "./Sidebar.logic";
import {
  buildActivityFamilies,
  buildActivityViewModel,
  collectActivityScopeOptions,
  collectUnreadActivityFamilyThreads,
  collectUnreadActivityThreads,
  collectVisibleActivityThreadIds,
  groupActivityThreadsByProject,
  hasUnreadActivity,
  isActivityThread,
  resolveActivityDateBucket,
  resolveActivityScope,
  resolveActivityStatusGroup,
  type ActivityFamily,
  type ActivityScopeOption,
  splitActivityThreadsByDateBucket,
  splitPriorityActivityThreads,
  splitRecentActivityThreads,
} from "./SidebarActivityView.logic";

const PROJECT_ID = ProjectId.makeUnsafe("project-1");

function makeSession(status: ThreadSession["status"]): ThreadSession {
  return {
    provider: "codex",
    status,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    orchestrationStatus: status === "running" ? "running" : "idle",
  } as ThreadSession;
}

function makeThread(input: {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  latestTurn?: SidebarThreadSummary["latestTurn"];
  lastVisitedAt?: string;
  latestUserMessageAt?: string | null;
  session?: ThreadSession | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasLiveTailWork?: boolean;
  archivedAt?: string | null;
  settledAt?: string | null;
  parentThreadId?: string | null;
  sourceThreadId?: string | null;
  isPinned?: boolean;
  projectId?: ProjectId;
}): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(input.id),
    projectId: input.projectId ?? PROJECT_ID,
    title: `Thread ${input.id}`,
    modelSelection: { provider: "codex", model: "gpt-5" },
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    session: input.session ?? null,
    createdAt: input.createdAt ?? "2026-08-01T09:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-08-01T10:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
    settledAt: input.settledAt ?? null,
    isPinned: input.isPinned ?? false,
    latestTurn: input.latestTurn ?? null,
    lastVisitedAt: input.lastVisitedAt,
    parentThreadId: input.parentThreadId ? ThreadId.makeUnsafe(input.parentThreadId) : null,
    sourceThreadId: input.sourceThreadId ? ThreadId.makeUnsafe(input.sourceThreadId) : null,
    latestUserMessageAt: input.latestUserMessageAt ?? null,
    hasPendingApprovals: input.hasPendingApprovals ?? false,
    hasPendingUserInput: input.hasPendingUserInput ?? false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: input.hasLiveTailWork ?? false,
  } satisfies SidebarThreadSummary;
}

function completedTurn(completedAt: string): SidebarThreadSummary["latestTurn"] {
  return {
    turnId: `turn-${completedAt}`,
    state: "completed",
    requestedAt: completedAt,
    startedAt: completedAt,
    completedAt,
  } as SidebarThreadSummary["latestTurn"];
}

function eligibleThread(
  id: string,
  completedAt = "2026-08-01T09:30:00.000Z",
): SidebarThreadSummary {
  return makeThread({ id, latestTurn: completedTurn(completedAt) });
}

/** Single-root families for already-eligible threads (no hierarchy). */
function familiesFor(
  threads: readonly SidebarThreadSummary[],
  sortOrder?: "updated_at" | "created_at",
): ActivityFamily[] {
  return buildActivityFamilies({ threads, ...(sortOrder ? { sortOrder } : {}) });
}

function familyRootIds(families: readonly ActivityFamily[]): string[] {
  return families.map((family) => family.rootId as string);
}

describe("isActivityThread", () => {
  it("excludes archived and never-run threads, but includes subagents", () => {
    expect(isActivityThread(makeThread({ id: "a", archivedAt: "2026-08-01T00:00:00Z" }))).toBe(
      false,
    );
    // Lote C: solo se elimina la exclusion por parentesco.
    expect(
      isActivityThread(
        makeThread({
          id: "b",
          parentThreadId: "parent",
          latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
        }),
      ),
    ).toBe(true);
    expect(isActivityThread(makeThread({ id: "c", latestTurn: null }))).toBe(false);
  });

  it("includes threads whose first turn is starting", () => {
    expect(isActivityThread(makeThread({ id: "d", latestTurn: null, hasLiveTailWork: true }))).toBe(
      true,
    );
  });

  it("includes threads that ran at least once", () => {
    expect(
      isActivityThread(
        makeThread({ id: "e", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      ),
    ).toBe(true);
  });
});

describe("resolveActivityStatusGroup", () => {
  it("puts answerable pending approvals in attention", () => {
    const thread = makeThread({
      id: "a",
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    expect(resolveActivityStatusGroup(thread)).toBe("attention");
  });

  it("ignores pending requests on dead sessions", () => {
    const thread = makeThread({
      id: "b",
      hasPendingApprovals: true,
      session: makeSession("closed"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("seen");
  });

  it("classifies live work as running", () => {
    const thread = makeThread({ id: "c", hasLiveTailWork: true });
    expect(resolveActivityStatusGroup(thread)).toBe("running");
  });

  it("classifies unseen completions", () => {
    const thread = makeThread({
      id: "d",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("unseenCompleted");
  });

  it("classifies visited completions as seen", () => {
    const thread = makeThread({
      id: "e",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    expect(resolveActivityStatusGroup(thread)).toBe("seen");
  });
});

describe("buildActivityViewModel", () => {
  it("orders active families attention → unseen → running → seen, newest first per group", () => {
    const createdAt = "2026-08-01T04:00:00.000Z";
    const seenOld = makeThread({
      id: "seen-old",
      createdAt,
      latestTurn: completedTurn("2026-08-01T07:30:00.000Z"),
      lastVisitedAt: "2026-08-01T07:45:00.000Z",
    });
    const seenNew = makeThread({
      id: "seen-new",
      createdAt,
      latestTurn: completedTurn("2026-08-01T08:30:00.000Z"),
      lastVisitedAt: "2026-08-01T08:45:00.000Z",
    });
    const running = makeThread({
      id: "running",
      createdAt,
      hasLiveTailWork: true,
      latestTurn: completedTurn("2026-08-01T06:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      createdAt,
      latestTurn: completedTurn("2026-08-01T05:30:00.000Z"),
      lastVisitedAt: "2026-08-01T05:00:00.000Z",
    });
    const attention = makeThread({
      id: "attention",
      createdAt,
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T04:30:00.000Z"),
    });

    const model = buildActivityViewModel({
      threads: [seenOld, seenNew, running, unseen, attention],
      pinnedThreadIdSet: new Set(),
    });

    expect(familyRootIds(model.active)).toEqual([
      "attention",
      "unseen",
      "running",
      "seen-new",
      "seen-old",
    ]);
  });

  it("keeps two simultaneously running families in a fixed order while they work", () => {
    const runningTurn = (startedAt: string): SidebarThreadSummary["latestTurn"] =>
      ({
        turnId: `turn-${startedAt}`,
        state: "running",
        requestedAt: startedAt,
        startedAt,
        completedAt: null,
      }) as SidebarThreadSummary["latestTurn"];
    const makeRunning = (id: string, startedAt: string, updatedAt: string) =>
      makeThread({
        id,
        createdAt: "2026-08-01T04:00:00.000Z",
        updatedAt,
        hasLiveTailWork: true,
        latestTurn: runningTurn(startedAt),
      });
    const order = (updatedA: string, updatedB: string) =>
      familyRootIds(
        buildActivityViewModel({
          threads: [
            makeRunning("run-a", "2026-08-01T09:00:00.000Z", updatedA),
            makeRunning("run-b", "2026-08-01T08:00:00.000Z", updatedB),
          ],
          pinnedThreadIdSet: new Set(),
        }).active,
      );

    // Whichever thread streamed most recently, the turn each one started still
    // decides the order — the rows must not swap mid-run.
    expect(order("2026-08-01T09:30:00.000Z", "2026-08-01T09:31:00.000Z")).toEqual([
      "run-a",
      "run-b",
    ]);
    expect(order("2026-08-01T09:32:00.000Z", "2026-08-01T09:31:00.000Z")).toEqual([
      "run-a",
      "run-b",
    ]);
  });

  it("orders attention families by when the pending interaction was requested", () => {
    const pendingApproval = (id: string, startedAt: string, updatedAt: string) =>
      makeThread({
        id,
        createdAt: "2026-08-01T04:00:00.000Z",
        updatedAt,
        hasPendingApprovals: true,
        session: makeSession("running"),
        latestTurn: {
          turnId: `turn-${id}`,
          state: "running",
          requestedAt: startedAt,
          startedAt,
          completedAt: null,
        } as SidebarThreadSummary["latestTurn"],
      });
    const olderTurnWithNewerApproval = pendingApproval(
      "older-turn-newer-approval",
      "2026-08-01T09:00:00.000Z",
      "2026-08-01T09:30:00.000Z",
    );
    const newerTurnWithOlderApproval = pendingApproval(
      "newer-turn-older-approval",
      "2026-08-01T09:15:00.000Z",
      "2026-08-01T09:20:00.000Z",
    );

    const model = buildActivityViewModel({
      threads: [newerTurnWithOlderApproval, olderTurnWithNewerApproval],
      pinnedThreadIdSet: new Set(),
    });

    expect(familyRootIds(model.active)).toEqual([
      "older-turn-newer-approval",
      "newer-turn-older-approval",
    ]);
  });

  it("keeps every pinned family exclusively in the Pinned section", () => {
    const pinnedUnread = makeThread({
      id: "pinned-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const pinnedSeen = makeThread({
      id: "pinned-seen",
      latestTurn: completedTurn("2026-08-01T09:20:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const pinnedSettledSeen = makeThread({
      id: "pinned-settled-seen",
      latestTurn: completedTurn("2026-08-01T09:10:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
      settledAt: "2026-08-01T09:45:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [pinnedUnread, pinnedSeen, pinnedSettledSeen],
      pinnedThreadIdSet: new Set([pinnedUnread.id, pinnedSeen.id, pinnedSettledSeen.id]),
    });

    expect(familyRootIds(model.pinned)).toEqual([
      "pinned-unread",
      "pinned-seen",
      "pinned-settled-seen",
    ]);
    expect(model.settled).toEqual([]);
    expect(model.active).toEqual([]);
  });

  it("applies optimistic settle overrides in both directions", () => {
    const optimisticallySettled = makeThread({
      id: "opt-settled",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const optimisticallyRestored = makeThread({
      id: "opt-restored",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
      settledAt: "2026-08-01T09:50:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [optimisticallySettled, optimisticallyRestored],
      pinnedThreadIdSet: new Set(),
      settledOverrideByThreadId: new Map([
        [optimisticallySettled.id, true],
        [optimisticallyRestored.id, false],
      ]),
    });

    expect(familyRootIds(model.settled)).toEqual(["opt-settled"]);
    expect(familyRootIds(model.active)).toEqual(["opt-restored"]);
  });

  it("promotes settled families while work is live, actionable, or newly completed", () => {
    const settledAt = "2026-08-01T08:00:00.000Z";
    const running = makeThread({ id: "running", settledAt, hasLiveTailWork: true });
    const attention = makeThread({
      id: "attention",
      settledAt,
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const reviewed = makeThread({
      id: "reviewed",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });

    const model = buildActivityViewModel({
      threads: [reviewed, running, attention, unseen],
      pinnedThreadIdSet: new Set(),
    });

    expect(familyRootIds(model.active)).toEqual(["attention", "unseen", "running"]);
    expect(familyRootIds(model.settled)).toEqual(["reviewed"]);
  });

  it("includes a family with an active child even when the root has no turn", () => {
    const root = makeThread({ id: "html-gastos", latestTurn: null });
    const child = makeThread({
      id: "implement",
      parentThreadId: "html-gastos",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });

    const model = buildActivityViewModel({ threads: [root, child], pinnedThreadIdSet: new Set() });
    expect(familyRootIds(model.active)).toEqual(["html-gastos"]);
    const family = model.active[0]!;
    expect(family.rootThread.id).toBe("html-gastos");
    expect(family.threads.map((thread) => thread.id)).toEqual(["html-gastos", "implement"]);
    expect(family.eligibleThreads.map((thread) => thread.id)).toEqual(["implement"]);
  });

  it("aggregates priority and recency from eligible members", () => {
    const root = makeThread({
      id: "root",
      latestTurn: completedTurn("2026-08-01T07:00:00.000Z"),
      lastVisitedAt: "2026-08-01T07:30:00.000Z",
    });
    const runningChild = makeThread({
      id: "child-running",
      parentThreadId: "root",
      hasLiveTailWork: true,
      latestTurn: completedTurn("2026-08-01T06:00:00.000Z"),
    });
    const unseenChild = makeThread({
      id: "child-unseen",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
      lastVisitedAt: "2026-08-01T08:00:00.000Z",
    });

    const [family] = buildActivityFamilies({ threads: [root, runningChild, unseenChild] });
    expect(family).toBeDefined();
    // unseenCompleted outranks running.
    expect(family!.statusGroup).toBe("unseenCompleted");
    expect(family!.recencyMs).toBe(Date.parse("2026-08-01T09:00:00.000Z"));
  });

  it("moves the whole family to Pinned once when any descendant is pinned", () => {
    const root = makeThread({ id: "root", latestTurn: completedTurn("2026-08-01T09:00:00.000Z") });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const model = buildActivityViewModel({
      threads: [root, child],
      pinnedThreadIdSet: new Set([child.id]),
    });
    expect(familyRootIds(model.pinned)).toEqual(["root"]);
    expect(model.active).toEqual([]);
    expect(model.settled).toEqual([]);
  });

  it("settles a family only when every eligible member is settled and seen", () => {
    const settledAt = "2026-08-01T08:00:00.000Z";
    const root = makeThread({
      id: "root",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
      lastVisitedAt: "2026-08-01T09:30:00.000Z",
    });
    const activeChild = makeThread({
      id: "child",
      parentThreadId: "root",
      settledAt,
      hasLiveTailWork: true,
    });
    const partiallySettled = buildActivityViewModel({
      threads: [root, activeChild],
      pinnedThreadIdSet: new Set(),
    });
    expect(familyRootIds(partiallySettled.active)).toEqual(["root"]);
    expect(partiallySettled.settled).toEqual([]);

    const settledChild = makeThread({
      id: "child",
      parentThreadId: "root",
      settledAt,
      latestTurn: completedTurn("2026-08-01T09:10:00.000Z"),
      lastVisitedAt: "2026-08-01T09:30:00.000Z",
    });
    const fullySettled = buildActivityViewModel({
      threads: [root, settledChild],
      pinnedThreadIdSet: new Set(),
    });
    expect(familyRootIds(fullySettled.settled)).toEqual(["root"]);
    expect(fullySettled.active).toEqual([]);
  });

  it("keeps batches with sourceThreadId nested instead of separate roots", () => {
    const root = makeThread({ id: "root", latestTurn: completedTurn("2026-08-01T09:00:00.000Z") });
    const batch = makeThread({
      id: "batch-1",
      sourceThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const model = buildActivityViewModel({ threads: [root, batch], pinnedThreadIdSet: new Set() });
    expect(familyRootIds(model.active)).toEqual(["root"]);
  });
});

describe("date buckets", () => {
  // Fixed "now": 2026-08-01T15:00 local time.
  const now = new Date(2026, 7, 1, 15, 0, 0);
  const nowMs = now.getTime();
  const localIso = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).toISOString();

  const threadAt = (iso: string) =>
    makeThread({ id: `thread-${iso}`, createdAt: iso, latestTurn: completedTurn(iso) });

  it("classifies today, yesterday, and earlier by local calendar day", () => {
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 7, 1, 9)), nowMs)).toBe("today");
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 6, 31, 23)), nowMs)).toBe("yesterday");
    expect(resolveActivityDateBucket(threadAt(localIso(2026, 6, 30, 23)), nowMs)).toBe("earlier");
  });

  it("splits an ordered family list preserving order inside each bucket", () => {
    const bucketThread = (id: string, iso: string) =>
      makeThread({ id, createdAt: iso, latestTurn: completedTurn(iso) });
    const todayA = bucketThread("today-a", localIso(2026, 7, 1, 14));
    const todayB = bucketThread("today-b", localIso(2026, 7, 1, 8));
    const yesterday = bucketThread("yesterday", localIso(2026, 6, 31, 12));
    const earlier = bucketThread("earlier", localIso(2026, 6, 20, 12));

    const buckets = splitActivityThreadsByDateBucket(
      familiesFor([todayA, todayB, yesterday, earlier]),
      nowMs,
    );
    expect(familyRootIds(buckets.today)).toEqual(["today-a", "today-b"]);
    expect(familyRootIds(buckets.yesterday)).toEqual(["yesterday"]);
    expect(familyRootIds(buckets.earlier)).toEqual(["earlier"]);
  });

  it("buckets a family by its newest eligible recency", () => {
    const root = makeThread({
      id: "root",
      createdAt: localIso(2026, 6, 20, 12),
      latestTurn: completedTurn(localIso(2026, 6, 20, 12)),
    });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      createdAt: localIso(2026, 7, 1, 14),
      latestTurn: completedTurn(localIso(2026, 7, 1, 14)),
    });
    const buckets = splitActivityThreadsByDateBucket(familiesFor([root, child]), nowMs);
    expect(familyRootIds(buckets.today)).toEqual(["root"]);
  });
});

describe("project filter", () => {
  const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");

  it("narrows every section of the view model", () => {
    const inProject = makeThread({
      id: "in-project",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const otherProject = {
      ...makeThread({
        id: "other-project",
        latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      }),
      projectId: OTHER_PROJECT_ID,
    };

    const model = buildActivityViewModel({
      threads: [inProject, otherProject],
      pinnedThreadIdSet: new Set(),
      projectFilterIds: new Set([PROJECT_ID]),
    });
    expect(familyRootIds(model.active)).toEqual(["in-project"]);
  });

  it("lists scope options busiest first and ignores drafts", () => {
    const projectA1 = makeThread({
      id: "a1",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const projectB1 = {
      ...makeThread({ id: "b1", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: OTHER_PROJECT_ID,
    };
    const projectB2 = {
      ...makeThread({ id: "b2", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: OTHER_PROJECT_ID,
    };
    const draft = makeThread({ id: "draft", latestTurn: null });

    expect(
      collectActivityScopeOptions([projectA1, projectB1, projectB2, draft], () => true),
    ).toEqual([
      { kind: "project", projectId: OTHER_PROJECT_ID, threadCount: 2 },
      { kind: "project", projectId: PROJECT_ID, threadCount: 1 },
    ]);
  });

  it("counts families, not rows, in scope options", () => {
    const root = makeThread({ id: "root", latestTurn: completedTurn("2026-08-01T09:00:00.000Z") });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    expect(collectActivityScopeOptions([root, child], () => true)).toEqual([
      { kind: "project", projectId: PROJECT_ID, threadCount: 1 },
    ]);
  });

  it("merges every project-less chat container into one Synara scope", () => {
    const CHAT_PROJECT_A = ProjectId.makeUnsafe("chat-project-a");
    const CHAT_PROJECT_B = ProjectId.makeUnsafe("chat-project-b");
    const realProject = makeThread({
      id: "real",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const chatA = {
      ...makeThread({ id: "chat-a", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: CHAT_PROJECT_A,
    };
    const chatB = {
      ...makeThread({ id: "chat-b", latestTurn: completedTurn("2026-08-01T09:30:00.000Z") }),
      projectId: CHAT_PROJECT_B,
    };

    const options = collectActivityScopeOptions(
      [realProject, chatA, chatB],
      (projectId) => projectId === PROJECT_ID,
    );
    expect(options).toEqual([
      { kind: "chats", projectIds: [CHAT_PROJECT_A, CHAT_PROJECT_B], threadCount: 2 },
      { kind: "project", projectId: PROJECT_ID, threadCount: 1 },
    ]);
  });

  it("merges project-less containers into one project-grouping section", () => {
    const CHAT_PROJECT_A = ProjectId.makeUnsafe("chat-project-a");
    const CHAT_PROJECT_B = ProjectId.makeUnsafe("chat-project-b");
    const groups = groupActivityThreadsByProject(
      familiesFor([
        makeThread({
          id: "project",
          projectId: PROJECT_ID,
          latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
        }),
        makeThread({
          id: "chat-a",
          projectId: CHAT_PROJECT_A,
          latestTurn: completedTurn("2026-08-01T09:20:00.000Z"),
        }),
        makeThread({
          id: "chat-b",
          projectId: CHAT_PROJECT_B,
          latestTurn: completedTurn("2026-08-01T09:10:00.000Z"),
        }),
      ]),
      (projectId) => projectId === PROJECT_ID,
      { nowMs: Date.parse("2026-08-01T12:00:00.000Z") },
    );

    expect(groups.map((group) => [group.kind, familyRootIds(group.families)])).toEqual([
      ["project", ["project"]],
      ["chats", ["chat-a", "chat-b"]],
    ]);
    expect(groups[1]).toMatchObject({
      key: "chats",
      kind: "chats",
      projectIds: [CHAT_PROJECT_A, CHAT_PROJECT_B],
    });
  });

  it("keeps a family indivisible inside project groups", () => {
    const root = makeThread({ id: "root", latestTurn: completedTurn("2026-08-01T09:00:00.000Z") });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const groups = groupActivityThreadsByProject(familiesFor([root, child]), () => true, {
      nowMs: Date.parse("2026-08-01T12:00:00.000Z"),
    });
    expect(groups).toHaveLength(1);
    expect(familyRootIds(groups[0]!.families)).toEqual(["root"]);
  });

  it("ranks projects touched in the current working day above newer untouched activity", () => {
    const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");
    // 01:30 local on Aug 2: the working day still started at 04:00 on Aug 1.
    const nowMs = new Date(2026, 7, 2, 1, 30, 0).getTime();
    const localIso = (day: number, hour: number) => new Date(2026, 7, day, hour).toISOString();

    const touched = {
      ...makeThread({
        id: "touched",
        projectId: PROJECT_ID,
        latestTurn: completedTurn(localIso(1, 22)),
        lastVisitedAt: localIso(1, 22),
      }),
    };
    // Newer agent output, but the user has not opened it since before the turnover.
    const untouched = {
      ...makeThread({
        id: "untouched",
        projectId: OTHER_PROJECT_ID,
        latestTurn: completedTurn(localIso(2, 1)),
        lastVisitedAt: localIso(1, 3),
      }),
    };

    const groups = groupActivityThreadsByProject(familiesFor([untouched, touched]), () => true, {
      nowMs,
    });
    expect(groups.map((group) => group.key)).toEqual([
      `project:${PROJECT_ID}`,
      `project:${OTHER_PROJECT_ID}`,
    ]);
  });
});

describe("resolveActivityScope", () => {
  const OTHER_PROJECT_ID = ProjectId.makeUnsafe("project-2");
  const options: ActivityScopeOption[] = [
    { kind: "project", projectId: PROJECT_ID, threadCount: 2 },
    { kind: "chats", projectIds: [OTHER_PROJECT_ID], threadCount: 1 },
  ];

  it("filters to the selected project", () => {
    expect(resolveActivityScope(PROJECT_ID, options)).toEqual({
      scope: PROJECT_ID,
      projectFilterIds: new Set([PROJECT_ID]),
    });
  });

  it("expands the Synara chats scope to its container projects", () => {
    expect(resolveActivityScope("chats", options)).toEqual({
      scope: "chats",
      projectFilterIds: new Set([OTHER_PROJECT_ID]),
    });
  });

  it("falls back to every project once the selected scope leaves the menu", () => {
    const withoutChats = options.filter((option) => option.kind !== "chats");
    expect(resolveActivityScope("chats", withoutChats)).toEqual({
      scope: null,
      projectFilterIds: null,
    });
    expect(resolveActivityScope(PROJECT_ID, [])).toEqual({ scope: null, projectFilterIds: null });
  });
});

describe("splitRecentActivityThreads", () => {
  it("keeps attention, unseen completions, and running work ahead of reviewed families", () => {
    const attention = makeThread({
      id: "attention",
      hasPendingApprovals: true,
      session: makeSession("running"),
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const unseen = makeThread({
      id: "unseen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const running = makeThread({ id: "running", hasLiveTailWork: true });
    const seen = makeThread({
      id: "seen",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });

    const split = splitPriorityActivityThreads(familiesFor([attention, unseen, running, seen]));
    expect(familyRootIds(split.priority)).toEqual(["attention", "unseen", "running"]);
    expect(familyRootIds(split.seen)).toEqual(["seen"]);
  });

  // Fixed "now": 2026-08-01T15:00 local time, so the working day started at 04:00.
  const recentNowMs = new Date(2026, 7, 1, 15, 0, 0).getTime();
  const localIso = (year: number, month: number, day: number, hour: number) =>
    new Date(year, month, day, hour).toISOString();
  const byInteraction = (id: string, lastVisitedAt: string, latestUserMessageAt?: string) => ({
    ...makeThread({
      id,
      latestTurn: completedTurn(lastVisitedAt),
      lastVisitedAt,
    }),
    latestUserMessageAt: latestUserMessageAt ?? null,
  });

  it("caps at the limit, sorts by newest interaction, and removes picks from the rest", () => {
    const active = familiesFor([
      byInteraction("a", localIso(2026, 7, 1, 10)),
      byInteraction("b", localIso(2026, 7, 1, 12)),
      // Older visit but newer user message: the message wins.
      byInteraction("c", localIso(2026, 7, 1, 8), localIso(2026, 7, 1, 13)),
      byInteraction("d", localIso(2026, 7, 1, 9)),
    ]);

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: recentNowMs, limit: 2 });
    expect(familyRootIds(recent)).toEqual(["c", "b"]);
    expect(familyRootIds(rest)).toEqual(["a", "d"]);
  });

  it("ages families last touched before today out of Recent, into the date buckets", () => {
    const active = familiesFor([
      byInteraction("today", localIso(2026, 7, 1, 9)),
      byInteraction("two-days-ago", localIso(2026, 6, 30, 14)),
      // Yesterday evening, past midnight but before the 4am turnover: still stale.
      byInteraction("last-night", localIso(2026, 6, 31, 23)),
    ]);

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: recentNowMs });
    expect(familyRootIds(recent)).toEqual(["today"]);
    expect(familyRootIds(rest)).toEqual(["two-days-ago", "last-night"]);
  });

  it("carries a past-midnight session as the same working day until 4am", () => {
    // 01:30 local: the working day still starts at 04:00 on the previous date.
    const afterMidnightMs = new Date(2026, 7, 2, 1, 30, 0).getTime();
    const active = familiesFor([
      byInteraction("late-night", localIso(2026, 7, 1, 23)),
      byInteraction("previous-day", localIso(2026, 7, 1, 3)),
    ]);

    const { recent, rest } = splitRecentActivityThreads(active, { nowMs: afterMidnightMs });
    expect(familyRootIds(recent)).toEqual(["late-night"]);
    expect(familyRootIds(rest)).toEqual(["previous-day"]);
  });

  it("keeps never-touched families out of Recent", () => {
    const untouched = {
      ...makeThread({ id: "untouched", latestTurn: completedTurn(localIso(2026, 7, 1, 9)) }),
      lastVisitedAt: undefined,
      latestUserMessageAt: null,
    };
    const { recent, rest } = splitRecentActivityThreads(familiesFor([untouched]), {
      nowMs: recentNowMs,
    });
    expect(recent).toEqual([]);
    expect(familyRootIds(rest)).toEqual(["untouched"]);
  });

  it("uses the max interaction of eligible members for Recent", () => {
    const root = makeThread({
      id: "root",
      latestTurn: completedTurn(localIso(2026, 7, 1, 8)),
      lastVisitedAt: localIso(2026, 7, 1, 8),
    });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn(localIso(2026, 7, 1, 8)),
      lastVisitedAt: localIso(2026, 7, 1, 12),
    });
    const { recent } = splitRecentActivityThreads(familiesFor([root, child]), {
      nowMs: recentNowMs,
      limit: 5,
    });
    expect(familyRootIds(recent)).toEqual(["root"]);
  });
});

describe("collectVisibleActivityThreadIds", () => {
  it("uses the mounted Activity rows and respects collapsed and paged sections", () => {
    const family = (id: string) => familiesFor([eligibleThread(id)])[0]!;
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "time",
        pinnedOpen: false,
        pinned: [family("pinned")],
        priority: [family("attention")],
        recent: [family("recent")],
        today: [family("today")],
        yesterday: [family("yesterday")],
        earlierOpen: true,
        earlier: [family("earlier-visible")],
        projectGroups: [],
        settledOpen: false,
        settled: [family("done")],
      }),
    ).toEqual(["attention", "recent", "today", "yesterday", "earlier-visible"]);
  });

  it("uses already-paged project groups in project mode", () => {
    const family = (id: string) => familiesFor([eligibleThread(id)])[0]!;
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "project",
        pinnedOpen: true,
        pinned: [family("pinned")],
        priority: [family("ignored-priority")],
        recent: [],
        today: [],
        yesterday: [],
        earlierOpen: false,
        earlier: [],
        projectGroups: [[family("project-a")], [family("project-b")]],
        settledOpen: true,
        settled: [family("done")],
      }),
    ).toEqual(["pinned", "project-a", "project-b", "done"]);
  });

  it("deduplicates a pinned family that also appears in Recent", () => {
    const duplicated = familiesFor([eligibleThread("pinned-unread")])[0]!;
    expect(
      collectVisibleActivityThreadIds({
        groupMode: "time",
        pinnedOpen: true,
        pinned: [duplicated],
        priority: [duplicated],
        recent: [],
        today: [],
        yesterday: [],
        earlierOpen: false,
        earlier: [],
        projectGroups: [],
        settledOpen: false,
        settled: [],
      }),
    ).toEqual([duplicated.rootId]);
  });

  it("excludes children of closed branches but includes them when expanded", () => {
    const root = makeThread({ id: "root", latestTurn: completedTurn("2026-08-01T09:00:00.000Z") });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
    });
    const [family] = familiesFor([root, child]);
    const base = {
      groupMode: "time" as const,
      pinnedOpen: false,
      pinned: [],
      priority: [family!],
      recent: [],
      today: [],
      yesterday: [],
      earlierOpen: false,
      earlier: [],
      projectGroups: [],
      settledOpen: false,
      settled: [],
    };
    expect(collectVisibleActivityThreadIds(base)).toEqual(["root"]);
    expect(
      collectVisibleActivityThreadIds({
        ...base,
        expandedThreadIds: new Set([family!.rootId]),
      }),
    ).toEqual(["root", "child"]);
  });
});

describe("collectUnreadActivityThreads", () => {
  it("collects only eligible threads with unseen completions", () => {
    const unread = makeThread({
      id: "unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const read = makeThread({
      id: "read",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:45:00.000Z",
    });
    const archivedUnread = makeThread({
      id: "archived",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
      archivedAt: "2026-08-01T10:00:00.000Z",
    });

    expect(collectUnreadActivityThreads([unread, read, archivedUnread]).map((t) => t.id)).toEqual([
      "unread",
    ]);
  });

  it("reaches eligible members in closed branches", () => {
    const root = makeThread({
      id: "root",
      latestTurn: completedTurn("2026-08-01T09:00:00.000Z"),
      lastVisitedAt: "2026-08-01T09:30:00.000Z",
    });
    const child = makeThread({
      id: "child",
      parentThreadId: "root",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const families = familiesFor([root, child]);
    expect(collectUnreadActivityFamilyThreads(families).map((t) => t.id)).toEqual(["child"]);
  });

  it("does not light the bell for the thread currently being read", () => {
    const activeUnread = makeThread({
      id: "active-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });
    const otherUnread = makeThread({
      id: "other-unread",
      latestTurn: completedTurn("2026-08-01T09:30:00.000Z"),
      lastVisitedAt: "2026-08-01T09:00:00.000Z",
    });

    expect(hasUnreadActivity([activeUnread], activeUnread.id)).toBe(false);
    expect(hasUnreadActivity([activeUnread, otherUnread], activeUnread.id)).toBe(true);
  });
});

describe("resolveThreadProjectLabel", () => {
  it("uses the project name for real projects and Synara otherwise", () => {
    expect(
      resolveThreadProjectLabel({ kind: "project", name: "Synara App", folderName: "synara" }),
    ).toBe("Synara App");
    expect(resolveThreadProjectLabel({ kind: "chat", name: "Chats", folderName: "chats" })).toBe(
      "Synara",
    );
    expect(resolveThreadProjectLabel(undefined)).toBe("Synara");
  });
});
