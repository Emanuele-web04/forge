// FILE: kanban.ts
// Purpose: Shared kanban domain vocabulary and v2 column derivation (Draft / In
//          Progress / Awaiting you / Done) consumed by both the web v2 board and
//          the server-side read-board tool. One derivation, two surfaces (D2).
// Layer: Shared domain logic — structural inputs only, no web/server imports.
//
// No wall-clock calls in this module: staleness consults an injected `now`
// (epoch ms) so tests run against a frozen clock. Live-work rules mirror the
// classic web derivation (`deriveKanbanColumn` in apps/web Kanban.logic) and the
// pending-request dead-session rule (`canSessionAnswerPendingRequests`).

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
 * Structural minimal view a thread must expose for the v2 derivation. Deliberately
 * not `SidebarThreadSummary` (web) or `OrchestrationThreadShell` (server) so the
 * same derivation serves both surfaces; each side projects its own thread shape
 * into this input at the adapter boundary. `session.status` is the
 * `OrchestrationSessionStatus` label in practice (both surfaces feed it).
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
   * Thread-level activity timestamp advanced on every appended message (e.g. a
   * streamed assistant reply). The authoritative heartbeat is the later of this
   * and `session.updatedAt` — the session row only moves on lifecycle
   * transitions, so a busy-but-quiet turn must never read as stale (mirrors
   * `projectedLifecycleAgeMs` in providerRuntimeReconciliation.ts).
   *
   * Web consumers feed the durable thread's last-message stamp here when their
   * summary projection freezes `updatedAt` on streaming deltas (see the web
   * adapter in kanban.logic.ts); the server consumes the durable row directly.
   */
  threadUpdatedAt?: string | null;
  /**
   * Epoch-ms stamp of the thread's last durable activity (messages appended).
   * A strictly fresher liveness input than `threadUpdatedAt` for surfaces whose
   * summary projection does not advance during streaming: the heartbeat is the
   * max of `session.updatedAt`, `threadUpdatedAt`, and this. Safely ignored when
   * the caller already carries a live thread stamp.
   */
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
 * Pending approval / user-input requests are only actionable while the session
 * that raised them can still receive the answer. Once the session is stopped or
 * errored the request is dead — status surfaces must not present the thread as
 * awaiting action forever after a provider crash. A thread with no session yet
 * keeps the request actionable: the flag can arrive ahead of the session
 * snapshot. Mirrors `canSessionAnswerPendingRequests` (apps/web session-logic).
 */
function canSessionAnswerPendingRequests(session: KanbanThreadDerivationInput["session"]): boolean {
  if (!session) {
    return true;
  }
  return !SESSION_ANSWER_UNANSWERABLE.has(session.status);
}

/**
 * Whether the latest turn is settled (its flow reached a terminal outcome). Mirrors
 * `isLatestTurnSettled` in apps/web session-logic: a requested-but-not-started turn is
 * not settled; an interrupted/error turn is settled even without a completedAt stamp;
 * a completed-and-stamped turn stays live while its session still reports running.
 */
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

/**
 * Whether the latest turn is live right now. Mirrors `hasLiveLatestTurn`: a null or
 * not-yet-started turn is never live (those cases are handled by the explicit running
 * / starting / running-no-turn branches in `hasKanbanLiveWork`).
 */
export function hasKanbanLiveLatestTurn(
  t: Pick<KanbanThreadDerivationInput, "latestTurn" | "session">,
): boolean {
  if (!t.latestTurn?.startedAt) {
    return false;
  }
  return !isKanbanTurnSettled(t);
}

/**
 * Whether the thread currently has live work. Mirrors the classic web derivation
 * (`deriveKanbanColumn`, apps/web Kanban.logic) with the shared session status label:
 *   - actionable pending requests (answerable by a living session) or a live-tail signal
 *   - a requested turn that has not produced startedAt yet (state "running")
 *   - a live latest turn under a running session
 *   - a starting session (the orchestrator's pre-init status)
 *   - a running session with no settled turn yet
 */
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

/**
 * Parses the effective heartbeat timestamp (epoch ms) for a thread: the later of
 * the session lifecycle stamp, the thread activity stamp (messages appended),
 * and — when provided — the durable last-activity stamp (epoch ms). Returns null
 * when nothing parses. Mirrors `projectedLifecycleAgeMs` in the server
 * reconciler, extended with `lastActivityTimestampMs` so surfaces with a frozen
 * summary projection can feed a fresher liveness input without touching their
 * hot-path dedupe.
 */
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
 * While the human is the binding constraint, the thread reads as Awaiting you:
 * actionable pending approval/input (only if a living session can answer — a dead
 * session falls through to its underlying live/done state), a failed agent (error
 * turn / error session / last error), or a stuck session (live-work claim with a
 * heartbeat stale past the hard threshold). Awaiting-you wins precedence over
 * In Progress (D1/D12).
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
 * Classifies a thread into the v2 column vocabulary (Draft / In Progress / Awaiting
 * you / Done). Classic rules for non-attention cases:
 *   - actionable pending + live tail → inProgress
 *   - live latest turn / starting session / running session → inProgress
 *   - no latestTurn ever → draft
 *   - everything else (settled) → done
 * Awaiting-you wins over In Progress when the human is the binding constraint.
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
 * The attention-flag set for a card, consumed by the web pill (S1-P6) and the read
 * tool's `attention` field (S2-P1). Awaiting-you reasons map to their pill flags;
 * a warn-stale heartbeat surfaces a "stuck" pill while the card is still In
 * Progress (the hard threshold hoists it to Awaiting you). `needsReview` is fed by
 * the caller from its PR source of truth (open `lastKnownPr` on first paint).
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
