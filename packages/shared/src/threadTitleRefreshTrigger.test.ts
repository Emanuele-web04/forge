import { describe, expect, it } from "vitest";

import {
  DEFAULT_THREAD_TITLE_REFRESH_TRIGGER,
  evaluateThreadTitleRefreshTrigger,
  type ThreadTitleRefreshTriggerInput,
} from "./threadTitleRefreshTrigger";

const base: ThreadTitleRefreshTriggerInput = {
  newUserTurnsSinceRefresh: 5,
  millisSinceLastAttempt: null,
  providerTurnActive: false,
  manualTitlePinned: false,
  attemptsInWindow: 0,
  nowMillis: 1_000_000,
  notBeforeMillis: null,
};

describe("threadTitleRefreshTrigger", () => {
  it("fires when never attempted and turn threshold met", () => {
    expect(evaluateThreadTitleRefreshTrigger(base)).toEqual({
      shouldRefresh: true,
      blockedBy: null,
    });
  });

  it("blocks on turn count", () => {
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, newUserTurnsSinceRefresh: 2 }),
    ).toEqual({ shouldRefresh: false, blockedBy: "need-more-turns" });
  });

  it("blocks on elapsed time since last attempt", () => {
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, millisSinceLastAttempt: 60_000 }),
    ).toEqual({ shouldRefresh: false, blockedBy: "need-more-time" });
    expect(
      evaluateThreadTitleRefreshTrigger({
        ...base,
        millisSinceLastAttempt: DEFAULT_THREAD_TITLE_REFRESH_TRIGGER.minElapsedMillis,
      }).shouldRefresh,
    ).toBe(true);
  });

  it("blocks while provider turn active and while pinned", () => {
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, providerTurnActive: true }),
    ).toEqual({ shouldRefresh: false, blockedBy: "provider-turn-active" });
    expect(evaluateThreadTitleRefreshTrigger({ ...base, manualTitlePinned: true })).toEqual({
      shouldRefresh: false,
      blockedBy: "pinned",
    });
  });

  it("blocks on rate limit and backoff (fake clock)", () => {
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, attemptsInWindow: 3 }),
    ).toEqual({ shouldRefresh: false, blockedBy: "rate-limited" });
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, notBeforeMillis: base.nowMillis + 1 }),
    ).toEqual({ shouldRefresh: false, blockedBy: "backoff" });
    expect(
      evaluateThreadTitleRefreshTrigger({ ...base, notBeforeMillis: base.nowMillis }),
    ).toEqual({ shouldRefresh: true, blockedBy: null });
  });
});
