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
const FRESH_NOW = { now: NOW };
// Canonical stale anchors: one tick past the warn/hard thresholds.
const HARD_STALE_MS = NOW - KANBAN_STUCK_HARD_MS - 60_000;
const WARN_STALE_MS = NOW - KANBAN_STUCK_WARN_MS - 60_000;
const STALE_ISO = new Date(HARD_STALE_MS).toISOString();

type Turn = NonNullable<KanbanThreadDerivationInput["latestTurn"]>;
type Session = NonNullable<KanbanThreadDerivationInput["session"]>;

const makeInput = (
  overrides: Partial<KanbanThreadDerivationInput> = {},
): KanbanThreadDerivationInput => ({
  latestTurn: null,
  // A thread that never ran has no session yet (mirrors the web fixture), so
  // callers that want a session pass one explicitly.
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasLiveTailWork: false,
  ...overrides,
});

const makeTurn = (overrides: Partial<Turn> = {}): Turn => ({
  state: "completed",
  startedAt: "2026-03-09T10:00:00.000Z",
  completedAt: "2026-03-09T10:05:00.000Z",
  ...overrides,
});

const makeSession = (overrides: Partial<Session> = {}): Session => ({
  status: "idle",
  updatedAt: new Date(NOW).toISOString(),
  ...overrides,
});

const LIVE_TURN = { state: "running", completedAt: null } as const;
// Running session whose heartbeat aged past the hard threshold.
const RUNNING_SESSION = () => makeSession({ status: "running", updatedAt: STALE_ISO });
const liveInput = (overrides: Partial<KanbanThreadDerivationInput> = {}) =>
  makeInput({ latestTurn: makeTurn(LIVE_TURN), session: RUNNING_SESSION(), ...overrides });

describe("isKanbanTurnSettled", () => {
  it("treats stamped, interrupted, and error turns as settled under a non-running session", () => {
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn() }))).toBe(true);
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn({ state: "interrupted" }) }))).toBe(
      true,
    );
    expect(isKanbanTurnSettled(makeInput({ latestTurn: makeTurn({ state: "error" }) }))).toBe(true);
  });

  it("keeps requested-but-unstarted turns and running-session turns live", () => {
    expect(
      isKanbanTurnSettled(
        makeInput({ latestTurn: makeTurn({ startedAt: null, completedAt: null }) }),
      ),
    ).toBe(false);
    expect(isKanbanTurnSettled(liveInput())).toBe(false);
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

  it("treats running/connecting sessions and unsettled turns as live work", () => {
    expect(hasKanbanLiveWork(liveInput())).toBe(true);
    expect(hasKanbanLiveWork(makeInput({ session: makeSession({ status: "starting" }) }))).toBe(
      true,
    );
    expect(
      hasKanbanLiveWork(
        makeInput({ latestTurn: makeTurn({ completedAt: null }), session: RUNNING_SESSION() }),
      ),
    ).toBe(true);
  });

  it("does not treat an idle/no-turn thread as live", () => {
    expect(hasKanbanLiveWork(makeInput())).toBe(false);
  });
});

describe("deriveKanbanColumnV2 (base matrix)", () => {
  it("puts live turn work, bare running sessions, and live tail work in progress", () => {
    expect(deriveKanbanColumnV2(liveInput())).toBe("inProgress");
    expect(deriveKanbanColumnV2(makeInput({ session: makeSession({ status: "running" }) }))).toBe(
      "inProgress",
    );
    expect(deriveKanbanColumnV2(makeInput({ hasLiveTailWork: true }))).toBe("inProgress");
  });

  it("puts never-ran threads in draft and settled threads in done regardless of outcome", () => {
    expect(deriveKanbanColumnV2(makeInput({ session: makeSession({ status: "ready" }) }))).toBe(
      "draft",
    );
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn() }))).toBe("done");
    expect(
      deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn({ state: "interrupted" }) })),
    ).toBe("done");
    expect(deriveKanbanColumnV2(makeInput({ latestTurn: makeTurn({ state: "error" }) }))).toBe(
      "done",
    );
  });

  it("falls dead-session pending requests through to their underlying state", () => {
    // Pending approval on a dead session with a settled turn → done; no turn → draft.
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
        makeInput({ hasPendingUserInput: true, session: makeSession({ status: "error" }) }),
      ),
    ).toBe("draft");
    // A live (or unknown) session keeps the request actionable.
    expect(
      deriveKanbanColumnV2(
        makeInput({ hasPendingUserInput: true, session: makeSession({ status: "running" }) }),
      ),
    ).toBe("inProgress");
    expect(deriveKanbanColumnV2(makeInput({ hasPendingUserInput: true }))).toBe("inProgress");
  });

  it("treats actionable pending requests as in progress regardless of turn state", () => {
    expect(deriveKanbanColumnV2(makeInput({ hasPendingApprovals: true }))).toBe("inProgress");
  });
});

describe("deriveKanbanAwaitingYouReason + deriveKanbanColumnV2 with frozen clock", () => {
  it("hoists actionable pending requests to awaitingYou, including blocked running turns (D12)", () => {
    const pendingApproval = makeInput({ hasPendingApprovals: true });
    expect(deriveKanbanAwaitingYouReason(pendingApproval, FRESH_NOW)).toBe("pending-approval");
    expect(deriveKanbanColumnV2(pendingApproval, FRESH_NOW)).toBe("awaitingYou");

    const pendingInput = makeInput({ hasPendingUserInput: true, session: RUNNING_SESSION() });
    expect(deriveKanbanAwaitingYouReason(pendingInput, FRESH_NOW)).toBe("pending-input");
    expect(deriveKanbanColumnV2(pendingInput, FRESH_NOW)).toBe("awaitingYou");

    const blockedTurn = liveInput({ hasPendingApprovals: true });
    expect(deriveKanbanAwaitingYouReason(blockedTurn, FRESH_NOW)).toBe("pending-approval");
    expect(deriveKanbanColumnV2(blockedTurn, FRESH_NOW)).toBe("awaitingYou");
  });

  it("flags errored sessions and error turns as failed", () => {
    const errorTurn = makeInput({
      latestTurn: makeTurn({ state: "error" }),
      session: makeSession({ status: "error", lastError: "boom" }),
    });
    expect(deriveKanbanAwaitingYouReason(errorTurn, FRESH_NOW)).toBe("failed");
    expect(deriveKanbanColumnV2(errorTurn, FRESH_NOW)).toBe("awaitingYou");
    expect(
      deriveKanbanAwaitingYouReason(
        makeInput({
          latestTurn: makeTurn(),
          session: makeSession({ status: "ready", lastError: "boom" }),
        }),
        FRESH_NOW,
      ),
    ).toBe("failed");
  });

  it("trips stuck past the hard threshold; warn-stale and fresh heartbeats stay in progress", () => {
    expect(deriveKanbanAwaitingYouReason(liveInput(), FRESH_NOW)).toBe("stuck");
    expect(deriveKanbanColumnV2(liveInput(), FRESH_NOW)).toBe("awaitingYou");

    // Warn-stale still earns a "stuck"-colored pill without leaving In Progress.
    const warnStale = liveInput({
      session: makeSession({ status: "running", updatedAt: new Date(WARN_STALE_MS).toISOString() }),
    });
    expect(deriveKanbanAwaitingYouReason(warnStale, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(warnStale, FRESH_NOW)).toBe("inProgress");
    expect(deriveKanbanAttention(warnStale, FRESH_NOW)).toContain("stuck");

    const fresh = liveInput({ session: makeSession({ status: "running" }) });
    expect(deriveKanbanAwaitingYouReason(fresh, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(fresh, FRESH_NOW)).toBe("inProgress");
  });

  it("keeps a busy-but-quiet turn fresh via the thread heartbeat, then stuck once it ages out (C1)", () => {
    // The session row only moves on lifecycle transitions, but the thread stamp
    // advances per appended message — the later of the two is the heartbeat.
    const busyThread = liveInput({ threadUpdatedAt: new Date(NOW - 60_000).toISOString() });
    expect(deriveKanbanAwaitingYouReason(busyThread, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(busyThread, FRESH_NOW)).toBe("inProgress");
    expect(deriveKanbanAttention(busyThread, FRESH_NOW)).toEqual([]);
    expect(
      deriveKanbanAwaitingYouReason(liveInput({ threadUpdatedAt: STALE_ISO }), FRESH_NOW),
    ).toBe("stuck");
  });

  it("never produces a negative heartbeat age at or before the heartbeat (C1)", () => {
    // A heartbeat stamped after the injected `now` (clock skew) must floor at 0,
    // not report a negative stale age.
    const skewed = liveInput({
      session: makeSession({ status: "running", updatedAt: new Date(NOW + 60_000).toISOString() }),
    });
    expect(deriveKanbanAwaitingYouReason(skewed, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(skewed, FRESH_NOW)).toBe("inProgress");
    expect(deriveKanbanAttention(skewed, FRESH_NOW)).toEqual([]);
  });

  it("keeps streaming turns fresh via the durable last-activity stamp until boundaries trip (F1)", () => {
    // `SidebarThreadSummary.updatedAt` freezes on the streaming hot path and the
    // session row only moves on lifecycle transitions — but the durable
    // per-thread last-activity stamp advances per appended message. A fresh
    // stamp must keep the turn In Progress despite the frozen summary.
    const fresh = liveInput({ threadUpdatedAt: null, lastActivityTimestampMs: NOW - 30_000 });
    expect(deriveKanbanAwaitingYouReason(fresh, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(fresh, FRESH_NOW)).toBe("inProgress");
    expect(deriveKanbanAttention(fresh, FRESH_NOW)).toEqual([]);

    const warned = liveInput({ lastActivityTimestampMs: WARN_STALE_MS });
    expect(deriveKanbanAttention(warned, FRESH_NOW)).toContain("stuck");

    const hardened = liveInput({ lastActivityTimestampMs: HARD_STALE_MS });
    expect(deriveKanbanAwaitingYouReason(hardened, FRESH_NOW)).toBe("stuck");
    expect(deriveKanbanColumnV2(hardened, FRESH_NOW)).toBe("awaitingYou");
  });

  it("flags the exact 20 min and 40 min boundaries (C4)", () => {
    const warnExact = liveInput({ lastActivityTimestampMs: NOW - KANBAN_STUCK_WARN_MS });
    expect(deriveKanbanAttention(warnExact, FRESH_NOW)).toContain("stuck");
    expect(deriveKanbanAwaitingYouReason(warnExact, FRESH_NOW)).toBeNull();

    const hardExact = liveInput({ lastActivityTimestampMs: NOW - KANBAN_STUCK_HARD_MS });
    expect(deriveKanbanAwaitingYouReason(hardExact, FRESH_NOW)).toBe("stuck");
    expect(deriveKanbanColumnV2(hardExact, FRESH_NOW)).toBe("awaitingYou");
  });

  it("never lets staleness override settled or dead-session threads", () => {
    // Falls pending + dead-session requests through (no awaitingYou).
    const deadPending = makeInput({
      hasPendingUserInput: true,
      latestTurn: makeTurn(),
      session: makeSession({ status: "stopped" }),
    });
    expect(deriveKanbanAwaitingYouReason(deadPending, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(deadPending, FRESH_NOW)).toBe("done");

    // A settled thread with a stale heartbeat stays done.
    const settled = makeInput({
      latestTurn: makeTurn(),
      session: makeSession({ status: "ready", updatedAt: STALE_ISO }),
    });
    expect(deriveKanbanAwaitingYouReason(settled, FRESH_NOW)).toBeNull();
    expect(deriveKanbanColumnV2(settled, FRESH_NOW)).toBe("done");
  });
});

describe("deriveKanbanAttention", () => {
  it("maps awaiting-you reasons and caller PR views to pills, staying quiet otherwise", () => {
    expect(deriveKanbanAttention(makeInput({ latestTurn: makeTurn() }), FRESH_NOW)).toEqual([]);
    expect(deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), FRESH_NOW)).toEqual([
      "awaiting-approval",
    ]);
    expect(deriveKanbanAttention(makeInput({ hasPendingUserInput: true }), FRESH_NOW)).toEqual([
      "awaiting-input",
    ]);
    expect(
      deriveKanbanAttention(
        makeInput({
          latestTurn: makeTurn({ state: "error" }),
          session: makeSession({ status: "error" }),
        }),
        FRESH_NOW,
      ),
    ).toEqual(["failed"]);
    expect(deriveKanbanAttention(liveInput(), FRESH_NOW)).toEqual(["stuck"]);
    expect(
      deriveKanbanAttention(makeInput({ latestTurn: makeTurn() }), {
        ...FRESH_NOW,
        needsReview: true,
      }),
    ).toEqual(["needs-review"]);
    expect(
      deriveKanbanAttention(makeInput({ hasPendingApprovals: true }), {
        ...FRESH_NOW,
        needsReview: true,
      }),
    ).toEqual(["awaiting-approval", "needs-review"]);
  });
});
