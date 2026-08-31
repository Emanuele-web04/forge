import { describe, expect, it } from "vitest";

import { planThrottledCommit } from "./useThrottledStreamingValue";

describe("planThrottledCommit", () => {
  it("commits immediately at the start of a burst", () => {
    expect(planThrottledCommit(0, 1_000, 160)).toEqual({ immediate: true });
  });

  it("commits immediately once the interval has elapsed", () => {
    expect(planThrottledCommit(1_000, 1_160, 160)).toEqual({ immediate: true });
    expect(planThrottledCommit(1_000, 1_500, 160)).toEqual({ immediate: true });
  });

  it("defers to the trailing edge of the current interval otherwise", () => {
    expect(planThrottledCommit(1_000, 1_040, 160)).toEqual({ immediate: false, delayMs: 120 });
    expect(planThrottledCommit(1_000, 1_159, 160)).toEqual({ immediate: false, delayMs: 1 });
  });
});
