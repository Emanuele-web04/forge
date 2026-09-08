import { expect, it } from "vitest";
import { parseCodexUsage } from "./codex";
it("labels a weekly primary window by duration instead of its position", () => {
  const result = parseCodexUsage({
    nowMs: Date.now(),
    json: { rate_limit: { primary_window: { used_percent: 84, limit_window_seconds: 604800 } } },
  });
  expect(result.limits).toEqual([{ window: "Weekly", usedPercent: 84, windowDurationMins: 10080 }]);
});
