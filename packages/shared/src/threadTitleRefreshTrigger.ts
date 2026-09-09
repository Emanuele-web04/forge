// FILE: threadTitleRefreshTrigger.ts
// Purpose: Deterministic milestone trigger for opt-in title refresh (#1041).
// Layer: Shared pure utility. All time/count inputs injected (fake-clock testable).
// Exports: trigger input, result, evaluator with turn/elapsed/settled/rate-limit gates.

export interface ThreadTitleRefreshTriggerInput {
  /** Settled user turns since last refresh attempt. */
  readonly newUserTurnsSinceRefresh: number;
  /** Milliseconds since last refresh attempt (null = never attempted). */
  readonly millisSinceLastAttempt: number | null;
  /** True while a provider turn is active. Refresh never fires then. */
  readonly providerTurnActive: boolean;
  /** True while a manual pin holds the title. Refresh never fires then. */
  readonly manualTitlePinned: boolean;
  /** Attempts inside current rate window (for rate-limit gate). */
  readonly attemptsInWindow: number;
  /** Current epoch millis (injected clock). */
  readonly nowMillis: number;
  /** Next allowed attempt epoch millis (null = no backoff). */
  readonly notBeforeMillis: number | null;
}

export interface ThreadTitleRefreshTriggerConfig {
  readonly minNewUserTurns: number;
  readonly minElapsedMillis: number;
  readonly maxAttemptsPerWindow: number;
}

export const DEFAULT_THREAD_TITLE_REFRESH_TRIGGER: ThreadTitleRefreshTriggerConfig = {
  minNewUserTurns: 5,
  minElapsedMillis: 10 * 60 * 1_000,
  maxAttemptsPerWindow: 3,
};

export type ThreadTitleRefreshGate =
  | "pinned"
  | "provider-turn-active"
  | "need-more-turns"
  | "need-more-time"
  | "rate-limited"
  | "backoff";

export interface ThreadTitleRefreshTriggerResult {
  readonly shouldRefresh: boolean;
  readonly blockedBy: ThreadTitleRefreshGate | null;
}

/** Pure gate evaluation. Order: pin > active turn > backoff > rate-limit > turns > elapsed. */
export function evaluateThreadTitleRefreshTrigger(
  input: ThreadTitleRefreshTriggerInput,
  config: ThreadTitleRefreshTriggerConfig = DEFAULT_THREAD_TITLE_REFRESH_TRIGGER,
): ThreadTitleRefreshTriggerResult {
  if (input.manualTitlePinned) return { shouldRefresh: false, blockedBy: "pinned" };
  if (input.providerTurnActive) return { shouldRefresh: false, blockedBy: "provider-turn-active" };
  if (input.notBeforeMillis !== null && input.nowMillis < input.notBeforeMillis) {
    return { shouldRefresh: false, blockedBy: "backoff" };
  }
  if (input.attemptsInWindow >= config.maxAttemptsPerWindow) {
    return { shouldRefresh: false, blockedBy: "rate-limited" };
  }
  if (input.newUserTurnsSinceRefresh < config.minNewUserTurns) {
    return { shouldRefresh: false, blockedBy: "need-more-turns" };
  }
  if (
    input.millisSinceLastAttempt !== null &&
    input.millisSinceLastAttempt < config.minElapsedMillis
  ) {
    return { shouldRefresh: false, blockedBy: "need-more-time" };
  }
  return { shouldRefresh: true, blockedBy: null };
}
