// Shared kanban vocabulary and v2 column derivation (Draft / In Progress /
// Awaiting you / Done), one derivation serving both the web board and the
// server read tool. Staleness consults an injected epoch-ms `now`; no
// wall-clock calls here.

import type { OrchestrationSessionStatus } from "@synara/contracts";

export type KanbanColumnV2Key = "draft" | "inProgress" | "awaitingYou" | "done";

export const KANBAN_COLUMN_V2_LABELS: Record<KanbanColumnV2Key, string> = {
  draft: "Draft",
  inProgress: "In Progress",
  awaitingYou: "Awaiting you",
  done: "Done",
};

export type KanbanAttentionFlag =
  | "failed"
  | "stuck"
  | "awaiting-approval"
  | "awaiting-input"
  | "needs-review";

/** Red-pill copy for the attention flags a card can carry. */
export const KANBAN_ATTENTION_LABELS: Record<KanbanAttentionFlag, string> = {
  failed: "Failed",
  stuck: "Stuck",
  "awaiting-approval": "Awaiting approval",
  "awaiting-input": "Awaiting your input",
  "needs-review": "Needs review",
};

/**
 * Structural view a thread must expose for the derivation — deliberately not
 * either surface's native type, so both project into it at their adapter.
 */
export interface KanbanThreadDerivationInput {
  latestTurn: {
    state: "running" | "interrupted" | "completed" | "error";
    startedAt: string | null;
    completedAt: string | null;
  } | null;
  session: {
    /** The orchestrator's session status label (`OrchestrationSessionStatus`). */
    status: OrchestrationSessionStatus;
    updatedAt: string;
    lastError?: string | null;
  } | null;
  /**
   * Thread-level activity stamps; the heartbeat is the latest of these and
   * `session.updatedAt`, so a busy-but-quiet turn never reads as stale even
   * when a summary projection freezes `updatedAt` on streaming deltas.
   */
  threadUpdatedAt?: string | null;
  /** Epoch-ms durable last-activity stamp (fresher still; optional). */
  lastActivityTimestampMs?: number | null;
  hasPendingApprovals?: boolean;
  hasPendingUserInput?: boolean;
  hasLiveTailWork?: boolean;
}

/** Default warn threshold for a stale session heartbeat (20 min). */
export const KANBAN_STUCK_WARN_MS = 20 * 60_000;
/** Default hard threshold for a definite stuck session (40 min). */
export const KANBAN_STUCK_HARD_MS = 40 * 60_000;

export type KanbanAwaitingYouReason = "pending-approval" | "pending-input" | "failed" | "stuck";

/**
 * Statuses in which a session can no longer receive an answer to a pending
 * approval/input request. Mirrors the web classic dead set (`"closed"`/`"error"`
 * in `canSessionAnswerPendingRequests`), written against the orchestrator's real
 * status vocabulary: `OrchestrationSessionStatus` has no `"closed"` literal —
 * the session-lifecycle terminal states are `stopped` (user/manual stop) and
 * `error` (provider failure). `idle` is a live-but-unstarted session that can
 * still receive the answer, unlike the legacy web phase it mapped through.
 */
const SESSION_ANSWER_UNANSWERABLE: ReadonlySet<OrchestrationSessionStatus> = new Set([
  "stopped",
  "error",
]);

/**
 * Pending requests die with their session: once it is stopped or errored the
 * request can never be answered, so the card must stop reading as awaiting
 * action. No session yet keeps the request actionable (flag may arrive first).
 */
function canSessionAnswerPendingRequests(session: KanbanThreadDerivationInput["session"]): boolean {
  if (!session) {
    return true;
  }
  return !SESSION_ANSWER_UNANSWERABLE.has(session.status);
}

/** Settled = terminal outcome: interrupted/error, or completed with a non-running session. */
export function isKanbanTurnSettled(
  t: Pick<KanbanThreadDerivationInput, "latestTurn" | "session">,
): boolean {
  const turn = t.latestTurn;
  if (!turn?.startedAt) {
    return false;
  }
  if (!turn.completedAt) {
    return false;
  }
  if (turn.state === "interrupted" || turn.state === "error") {
    return true;
  }
  if (!t.session) {
    return true;
  }
  if (t.session.status === "running") {
    return false;
  }
  return true;
}

/** Live latest turn; null/unstarted turns are handled by hasKanbanLiveWork branches. */
export function hasKanbanLiveLatestTurn(
  t: Pick<KanbanThreadDerivationInput, "latestTurn" | "session">,
): boolean {
  if (!t.latestTurn?.startedAt) {
    return false;
  }
  return !isKanbanTurnSettled(t);
}

/** Whether the thread currently has live work (pending requests, live tail, or live turn/session). */
export function hasKanbanLiveWork(t: KanbanThreadDerivationInput): boolean {
  const canAnswerPending = canSessionAnswerPendingRequests(t.session);
  if ((t.hasPendingApprovals === true || t.hasPendingUserInput === true) && canAnswerPending) {
    return true;
  }
  if (t.hasLiveTailWork === true) {
    return true;
  }
  // A requested turn that has not produced startedAt yet is still live work.
  if (t.latestTurn?.state === "running") {
    return true;
  }
  if (hasKanbanLiveLatestTurn(t)) {
    return true;
  }
  const status = t.session?.status;
  if (status === "starting" || status === "running") {
    return true;
  }
  return false;
}

/** Effective heartbeat (epoch ms): the latest of the three activity stamps, null if none parses. */
export function kanbanHeartbeatTimestampMs(
  t: Pick<KanbanThreadDerivationInput, "session" | "threadUpdatedAt" | "lastActivityTimestampMs">,
): number | null {
  const sessionObservedAt = t.session ? Date.parse(t.session.updatedAt) : Number.NaN;
  const threadObservedAt = Date.parse(t.threadUpdatedAt ?? "");
  const activityObservedAt =
    typeof t.lastActivityTimestampMs === "number" && Number.isFinite(t.lastActivityTimestampMs)
      ? t.lastActivityTimestampMs
      : Number.NaN;
  const observedAt = Math.max(
    Number.isFinite(sessionObservedAt) ? sessionObservedAt : Number.NEGATIVE_INFINITY,
    Number.isFinite(threadObservedAt) ? threadObservedAt : Number.NEGATIVE_INFINITY,
    Number.isFinite(activityObservedAt) ? activityObservedAt : Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(observedAt) ? observedAt : null;
}

type HeartbeatInput = Pick<
  KanbanThreadDerivationInput,
  "session" | "threadUpdatedAt" | "lastActivityTimestampMs"
>;

/** Seconds-aware staleness: heartbeat age floored at 0 (never negative). */
function heartbeatAgeMs(t: HeartbeatInput, opts: { now: number }): number | null {
  const heartbeat = kanbanHeartbeatTimestampMs(t);
  return heartbeat !== null ? Math.max(0, opts.now - heartbeat) : null;
}

/** Whether the effective heartbeat is stale past-or-at the hard stuck threshold. */
function isHardStuck(t: HeartbeatInput, opts: { now: number }): boolean {
  const ageMs = heartbeatAgeMs(t, opts);
  return ageMs !== null && ageMs >= KANBAN_STUCK_HARD_MS;
}

/** Whether the effective heartbeat is stale past-or-at the warn stuck threshold. */
function isWarnStuck(t: HeartbeatInput, opts: { now: number }): boolean {
  const ageMs = heartbeatAgeMs(t, opts);
  return ageMs !== null && ageMs >= KANBAN_STUCK_WARN_MS;
}

/**
 * Why the human is the binding constraint: failed > pending approval/input >
 * stuck (live work with a heartbeat past the hard threshold). A dead session's
 * pending flags fall through to the underlying live/done state.
 */
export function deriveKanbanAwaitingYouReason(
  t: KanbanThreadDerivationInput,
  opts: { now: number },
): KanbanAwaitingYouReason | null {
  // Failed wins precedence over actionable pending: an errored turn/session is
  // the agent's terminal state, so a pending flag on top of it must not read as
  // "awaiting your approval" — it reads as "this failed".
  if (t.latestTurn?.state === "error") {
    return "failed";
  }
  if (t.session?.status === "error" || (t.session?.lastError ?? null) != null) {
    return "failed";
  }
  const canAnswerPending = canSessionAnswerPendingRequests(t.session);
  if (canAnswerPending) {
    if (t.hasPendingApprovals === true) {
      return "pending-approval";
    }
    if (t.hasPendingUserInput === true) {
      return "pending-input";
    }
  }
  if (hasKanbanLiveWork(t) && isHardStuck(t, opts)) {
    return "stuck";
  }
  return null;
}

/**
 * Column classification: awaitingYou wins over live work; then inProgress,
 * draft (never ran a turn), done (settled).
 */
export function deriveKanbanColumnV2(
  t: KanbanThreadDerivationInput,
  opts?: { now?: number },
): KanbanColumnV2Key {
  if (opts?.now !== undefined) {
    const reason = deriveKanbanAwaitingYouReason(t, { now: opts.now });
    if (reason !== null) {
      return "awaitingYou";
    }
  }
  if (hasKanbanLiveWork(t)) {
    return "inProgress";
  }
  if (!t.latestTurn) {
    return "draft";
  }
  return "done";
}

/**
 * Card attention flags: the awaiting-you reason as a pill, plus "stuck" on a
 * warn-stale heartbeat while still In Progress, plus needs-review per caller.
 */
export function deriveKanbanAttention(
  t: KanbanThreadDerivationInput,
  opts: { now: number; needsReview?: boolean },
): KanbanAttentionFlag[] {
  const flags: KanbanAttentionFlag[] = [];
  const reason = deriveKanbanAwaitingYouReason(t, opts);
  if (reason === "pending-approval") {
    flags.push("awaiting-approval");
  } else if (reason === "pending-input") {
    flags.push("awaiting-input");
  } else if (reason === "failed") {
    flags.push("failed");
  } else if (reason === "stuck") {
    flags.push("stuck");
  }
  // A warn-stale heartbeat earns the "stuck" pill while the card is still In
  // Progress; once the hard threshold hoists it to Awaiting you the reason flag
  // already carries "stuck", so do not double-push it.
  if (hasKanbanLiveWork(t) && isWarnStuck(t, opts) && reason !== "stuck") {
    flags.push("stuck");
  }
  if (opts.needsReview === true) {
    flags.push("needs-review");
  }
  return flags;
}
