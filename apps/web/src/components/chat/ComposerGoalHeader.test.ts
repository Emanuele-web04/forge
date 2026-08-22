// FILE: ComposerGoalHeader.test.ts
// Purpose: Covers the goal pursuit clock: live elapsed time, the frozen clock
// while paused, and the hidden timer for legacy goals without a start stamp.

import { describe, expect, it } from "vitest";

import { goalElapsedMs } from "./ComposerGoalHeader";

const STARTED_AT = "2026-08-13T10:00:00.000Z";
const STARTED_AT_MS = Date.parse(STARTED_AT);

describe("goalElapsedMs", () => {
  it("tracks wall-clock time while the goal is running", () => {
    expect(goalElapsedMs({ goalStartedAt: STARTED_AT }, STARTED_AT_MS + 4_000)).toBe(4_000);
    expect(
      goalElapsedMs({ goalStartedAt: STARTED_AT, goalPausedAt: null }, STARTED_AT_MS + 65_000),
    ).toBe(65_000);
  });

  it("freezes at the pause stamp regardless of the current time", () => {
    const pausedAt = new Date(STARTED_AT_MS + 11_000).toISOString();
    expect(
      goalElapsedMs({ goalStartedAt: STARTED_AT, goalPausedAt: pausedAt }, STARTED_AT_MS + 999_000),
    ).toBe(11_000);
  });

  it("hides the timer for legacy goals without a start stamp", () => {
    expect(goalElapsedMs({}, STARTED_AT_MS)).toBeNull();
    expect(goalElapsedMs({ goalStartedAt: null }, STARTED_AT_MS)).toBeNull();
    expect(goalElapsedMs({ goalStartedAt: "not-a-date" }, STARTED_AT_MS)).toBeNull();
  });

  it("clamps clock skew to zero instead of going negative", () => {
    expect(goalElapsedMs({ goalStartedAt: STARTED_AT }, STARTED_AT_MS - 5_000)).toBe(0);
  });
});
