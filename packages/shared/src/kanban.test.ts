import { describe, expect, it } from "vitest";
import {
  KANBAN_ATTENTION_LABELS,
  KANBAN_COLUMN_V2_LABELS,
  KANBAN_STUCK_HARD_MS,
  KANBAN_STUCK_WARN_MS,
  deriveKanbanAttention,
  deriveKanbanAwaitingYouReason,
  deriveKanbanColumnV2,
  hasKanbanLiveWork,
  isKanbanTurnSettled,
  type KanbanAttentionFlag,
  type KanbanColumnV2Key,
  type KanbanThreadDerivationInput,
} from "./kanban";

const COLUMN_V2_KEYS = [
  "draft",
  "inProgress",
  "awaitingYou",
  "done",
] as const satisfies readonly KanbanColumnV2Key[];

const ATTENTION_FLAGS = [
  "failed",
  "stuck",
  "awaiting-approval",
  "awaiting-input",
  "needs-review",
] as const satisfies readonly KanbanAttentionFlag[];

// Frozen clock: anything far in the future is a "fresh heartbeat" anchor.
const NOW = Date.parse("2026-03-09T12:00:00.000Z");

function makeInput(
  overrides: Partial<KanbanThreadDerivationInput> = {},
): KanbanThreadDerivationInput {
  return {
    latestTurn: null,
    // A thread that never ran has no session yet (mirrors the web fixture), so
    // callers that want a session pass one explicitly.
    session: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasLiveTailWork: false,
    ...overrides,
  };
}

function makeTurn(
  overrides: Partial<NonNullable<KanbanThreadDerivationInput["latestTurn"]>> = {},
): NonNullable<KanbanThreadDerivationInput["latestTurn"]> {
  return {
    state: "completed",
    startedAt: "2026-03-09T10:00:00.000Z",
    completedAt: "2026-03-09T10:05:00.000Z",
    ...overrides,
  };
}

function makeSession(
  overrides: Partial<NonNullable<KanbanThreadDerivationInput["session"]>> = {},
): NonNullable<KanbanThreadDerivationInput["session"]> {
  return {
    status: "idle",
    updatedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}

describe("kanban v2 vocabulary", () => {
  it("labels every v2 column key and nothing else", () => {
    expect(Object.keys(KANBAN_COLUMN_V2_LABELS).toSorted()).toEqual([...COLUMN_V2_KEYS].toSorted());
    for (const key of COLUMN_V2_KEYS) {
      expect(KANBAN_COLUMN_V2_LABELS[key]).toBeTypeOf("string");
      expect(KANBAN_COLUMN_V2_LABELS[key].length).toBeGreaterThan(0);
    }
  });

  it("labels every attention flag and nothing else", () => {
    expect(Object.keys(KANBAN_ATTENTION_LABELS).toSorted()).toEqual(
      [...ATTENTION_FLAGS].toSorted(),
    );
    for (const flag of ATTENTION_FLAGS) {
      expect(KANBAN_ATTENTION_LABELS[flag]).toBeTypeOf("string");
      expect(KANBAN_ATTENTION_LABELS[flag].length).toBeGreaterThan(0);
    }
  });

  it("keeps the awaiting-you column label distinct from the other columns", () => {
    expect(KANBAN_COLUMN_V2_LABELS.awaitingYou).toBe("Awaiting you");
    expect(KANBAN_COLUMN_V2_LABELS.awaitingYou).not.toBe(KANBAN_COLUMN_V2_LABELS.inProgress);
  });
});

describe("isKanbanTurnSettled", () => {
  it("treats a requested-but-not-started turn as live", () => {
    expect(
      isKanbanTurnSettled(
        makeInput({ latestTurn: makeTurn({ startedAt: null, completedAt: null }) }),
      ),
    ).toBe(false);
  });

  it("treats a completed-and-stamped turn as settled under a non-running session", () => {
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn() }))).toBe(true);
  });

  it("keeps a completed turn live while the session still runs", () => {
    expect(
      isKanbanTurnSettled(
        makeInput({
          latestTurn: makeTurn(),
          session: makeSession({
            status: "running",
            updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
          }),
        }),
      ),
    ).toBe(false);
  });

  it("treats interrupted/error turns as settled even without a completedAt stamp", () => {
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn({ state: "interrupted" }) }))).toBe(
      true,
    );
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn({ state: "error" }) }))).toBe(true);
  });
});

describe("hasKanbanLiveWork", () => {
  it("counts actionable pending requests and live tail work as live", () => {
    expect(hasKanbanLiveWork(makeInput({ hasPendingApprovals: true }))).toBe(true);
    expect(hasKanbanLiveWork(makeInput({ hasPendingUserInput: true }))).toBe(true);
    expect(hasKanbanLiveWork(makeInput({ hasLiveTailWork: true }))).toBe(true);
  });

  it("ignores pending requests once the session is dead", () => {
    expect(
      hasKanbanLiveWork(
        makeInput({ hasPendingUserInput: true, session: makeSession({ status: "stopped" }) }),
      ),
    ).toBe(false);
    expect(
      hasKanbanLiveWork(
        makeInput({ hasPendingApprovals: true, session: makeSession({ status: "error" }) }),
      ),
    ).toBe(false);
  });

  it("treats a live latest turn as live work", () => {
    expect(
      hasKanbanLiveWork({
        latestTurn: makeTurn({ state: "running", completedAt: null }),
        session: makeSession({
          status: "running",
          updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
        }),
      }),
    ).toBe(true);
  });

  it("treats connecting/starting sessions as live work", () => {
    expect(hasKanbanLiveWork(makeInput({ session: makeSession({ status: "starting" }) }))).toBe(
      true,
    );
  });

  it("treats a running session without a settled turn as live work", () => {
    expect(
      hasKanbanLiveWork(
        makeInput({
          latestTurn: makeTurn({ completedAt: null }),
          session: makeSession({
            status: "running",
            updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
          }),
        }),
      ),
    ).toBe(true);
  });

  it("does not treat an idle/no-turn thread as live", () => {
    expect(hasKanbanLiveWork(makeInput())).toBe(false);
  });
});

describe("deriveKanbanColumnV2 (no `now`: base matrix)", () => {
  it("puts live turn work in progress", () => {
    expect(
      deriveKanbanColumnV2(
        makeInput({
          latestTurn: makeTurn({ state: "running", completedAt: null }),
          session: makeSession({
            status: "running",
            updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
          }),
        }),
      ),
    ).toBe("inProgress");
  });

  it("puts a session running with no turn in progress", () => {
    expect(deriveKanbanColumnV2(makeInput({ session: makeSession({ status: "running" }) }))).toBe(
      "inProgress",
    );
  });

  it("puts live-tail work in progress", () => {
    expect(deriveKanbanColumnV2(makeInput({ hasLiveTailWork: true }))).toBe("inProgress");
  });

  it("treats a never-ran thread as draft", () => {
    expect(deriveKanbanColumnV2(makeInput({ session: makeSession({ status: "ready" }) }))).toBe(
      "draft",
    );
  });

  it("puts settled threads in done", () => {
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn() }))).toBe("done");
  });

  it("puts settled interrupted/error threads in done", () => {
    expect(
      deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn({ state: "interrupted" }) })),
    ).toBe("done");
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn({ state: "error" }) }))).toBe(
      "done",
    );
  });

  it("falls dead-session pending requests through to their underlying state", () => {
    // pending approval on a dead session with a settled turn → done; with no turn → draft
    expect(
      deriveKanbanColumnV2(
        makeInput({
          hasPendingApprovals: true,
          latestTurn: makeTurn(),
          session: makeSession({ status: "stopped" }),
        }),
      ),
    ).toBe("done");
    expect(
      deriveKanbanColumnV2(
        makeInput({
          hasPendingUserInput: true,
          session: makeSession({ status: "error" }),
        }),
      ),
    ).toBe("draft");
    // A live (or unknown) session keeps the request actionable.
    expect(
      deriveKanbanColumnV2(
        makeInput({ hasPendingUserInput: true, session: makeSession({ status: "running" }) }),
      ),
    ).toBe("inProgress");
    expect(deriveKanbanColumnV2(makeInput({ hasPendingUserInput: true, session: null }))).toBe(
      "inProgress",
    );
  });

  it("treats actionable pending requests as in progress regardless of turn state", () => {
    expect(deriveKanbanColumnV2(makeInput({ hasPendingApprovals: true }))).toBe("inProgress");
  });
});

describe("deriveKanbanAwaitingYouReason + deriveKanbanColumnV2 with frozen clock", () => {
  const freshNow = { now: NOW };

  it("flags actionable pending approvals as pending-approval (awaitingYou)", () => {
    const input = makeInput({ hasPendingApprovals: true });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("pending-approval");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });

  it("flags actionable pending user input as pending-input (awaitingYou)", () => {
    const input = makeInput({
      hasPendingUserInput: true,
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("pending-input");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });

  it("hoists a running turn blocked on the human to awaitingYou (D12)", () => {
    const input = makeInput({
      hasPendingApprovals: true,
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("pending-approval");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });

  it("flags a failed agent as failed (awaitingYou)", () => {
    const errorTurn = makeInput({
      latestTurn: makeTurn({ state: "error", completedAt: "2026-03-09T10:05:00.000Z" }),
      session: makeSession({ status: "error", lastError: "boom" }),
    });
    expect(deriveKanbanAwaitingYouReason(errorTurn, freshNow)).toBe("failed");
    expect(deriveKanbanColumnV2(errorTurn, freshNow)).toBe("awaitingYou");

    const lastErrorOnly = makeInput({
      latestTurn: makeTurn(),
      session: makeSession({ status: "ready", lastError: "boom" }),
    });
    expect(deriveKanbanAwaitingYouReason(lastErrorOnly, freshNow)).toBe("failed");
  });

  it("flags a live thread with a stale heartbeat past the hard threshold as stuck (awaitingYou)", () => {
    const stale = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: stale }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("stuck");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });

  it("keeps a fresh heartbeat in progress (not stuck, not awaiting)", () => {
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: new Date(NOW).toISOString() }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("inProgress");
  });

  it("falls pending + dead-session requests through (no awaitingYou)", () => {
    const deadPending = makeInput({
      hasPendingUserInput: true,
      latestTurn: makeTurn(),
      session: makeSession({ status: "stopped" }),
    });
    expect(deriveKanbanAwaitingYouReason(deadPending, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(deadPending, freshNow)).toBe("done");
  });

  it("does not flag a settled thread as stuck even with a stale heartbeat", () => {
    const stale = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "completed" }),
      session: makeSession({ status: "ready", updatedAt: stale }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("done");
  });

  it("flags a warn-stale live thread as still in progress (hard not reached)", () => {
    const warnStale = new Date(NOW - KANBAN_STUCK_WARN_MS - 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: warnStale }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("inProgress");
    // the warn-stale heartbeat still earns a "stuck"-colored pill
    expect(deriveKanbanAttention(input, freshNow)).toContain("stuck");
  });

  it("keeps a busy-but-quiet turn fresh via the thread heartbeat (C1)", () => {
    // The session row only moves on lifecycle transitions, but the thread stamp
    // advances per appended message — the later of the two is the heartbeat.
    const staleSession = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    const busyThread = new Date(NOW - 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: staleSession }),
      threadUpdatedAt: busyThread,
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("inProgress");
    expect(deriveKanbanAttention(input, freshNow)).toEqual([]);
  });

  it("falls the busy-quiet turn back to stuck when the thread heartbeat also ages out (C1)", () => {
    const stale = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: stale }),
      threadUpdatedAt: stale,
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("stuck");
  });

  it("never produces a negative heartbeat age at or before the heartbeat (C1)", () => {
    // A heartbeat stamped after the injected `now` (clock skew) must floor at 0,
    // not report a negative stale age.
    const futureHeartbeat = new Date(NOW + 60_000).toISOString();
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: futureHeartbeat }),
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("inProgress");
    expect(deriveKanbanAttention(input, freshNow)).toEqual([]);
  });

  it("keeps a busy-but-quiet streaming turn fresh via the durable last-activity stamp (F1)", () => {
    // `SidebarThreadSummary.updatedAt` freezes on the streaming hot path, and the
    // session row only moves on lifecycle transitions — but the durable per-thread
    // last-activity stamp advances per appended message. A fresh stamp must keep
    // the turn In Progress with no stuck pill despite the frozen summary.
    const staleSession = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    const freshActivity = NOW - 30_000;
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({ status: "running", updatedAt: staleSession }),
      threadUpdatedAt: null,
      lastActivityTimestampMs: freshActivity,
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("inProgress");
    expect(deriveKanbanAttention(input, freshNow)).toEqual([]);
  });

  it("trips the warn boundary when the durable last-activity stamp ages past 20 min (F1)", () => {
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
      lastActivityTimestampMs: NOW - KANBAN_STUCK_WARN_MS - 60_000,
    });
    expect(deriveKanbanAttention(input, freshNow)).toContain("stuck");
  });

  it("trips the hard boundary and hoists to awaitingYou past 40 min (F1)", () => {
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
      lastActivityTimestampMs: NOW - KANBAN_STUCK_HARD_MS - 60_000,
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("stuck");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });

  it("flags the warn boundary exactly at 20:00.000 (C4)", () => {
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
      lastActivityTimestampMs: NOW - KANBAN_STUCK_WARN_MS,
    });
    expect(deriveKanbanAttention(input, freshNow)).toContain("stuck");
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBeNull();
  });

  it("flags the hard boundary exactly at 40:00.000 (C4)", () => {
    const input = makeInput({
      latestTurn: makeTurn({ state: "running", completedAt: null }),
      session: makeSession({
        status: "running",
        updatedAt: new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString(),
      }),
      lastActivityTimestampMs: NOW - KANBAN_STUCK_HARD_MS,
    });
    expect(deriveKanbanAwaitingYouReason(input, freshNow)).toBe("stuck");
    expect(deriveKanbanColumnV2(input, freshNow)).toBe("awaitingYou");
  });
});

describe("deriveKanbanAttention", () => {
  it("produces no flags for a plain settled thread", () => {
    expect(deriveKanbanAttention(makeInput({ latestTurn: makeTurn() }), { now: NOW })).toEqual([]);
  });

  it("maps awaiting-you reasons to their pill flags", () => {
    expect(deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), { now: NOW })).toEqual([
      "awaiting-approval",
    ]);
    expect(deriveKanbanAttention(makeInput({ hasPendingUserInput: true }), { now: NOW })).toEqual([
      "awaiting-input",
    ]);
    expect(
      deriveKanbanAttention(
        makeInput({
          latestTurn: makeTurn({ state: "error" }),
          session: makeSession({ status: "error" }),
        }),
        { now: NOW },
      ),
    ).toEqual(["failed"]);
    const stale = new Date(NOW - KANBAN_STUCK_HARD_MS - 60_000).toISOString();
    expect(
      deriveKanbanAttention(
        makeInput({
          latestTurn: makeTurn({ state: "running", completedAt: null }),
          session: makeSession({ status: "running", updatedAt: stale }),
        }),
        { now: NOW },
      ),
    ).toEqual(["stuck"]);
  });

  it("adds needs-review from the caller's PR view", () => {
    expect(
      deriveKanbanAttention(makeInput({ latestTurn: makeTurn() }), { now: NOW, needsReview: true }),
    ).toEqual(["needs-review"]);
    expect(
      deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), {
        now: NOW,
        needsReview: true,
      }),
    ).toEqual(["awaiting-approval", "needs-review"]);
  });
});
