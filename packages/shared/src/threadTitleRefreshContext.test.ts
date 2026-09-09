import { describe, expect, it } from "vitest";

import {
  buildThreadTitleRefreshContext,
  THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS,
} from "./threadTitleRefreshContext";

describe("threadTitleRefreshContext", () => {
  it("returns null when no usable material", () => {
    expect(
      buildThreadTitleRefreshContext({ currentTitle: "Old", recentUserIntents: [], compactSummary: null }),
    ).toBeNull();
    expect(
      buildThreadTitleRefreshContext({ currentTitle: "", recentUserIntents: ["  "], compactSummary: " " }),
    ).toBeNull();
  });

  it("assembles title + intents + summary", () => {
    const context = buildThreadTitleRefreshContext({
      currentTitle: "Investigate OAuth",
      recentUserIntents: ["Fix callback validation", "Update middleware tests"],
      compactSummary: "Auth debugging thread",
    });
    expect(context).toContain("Investigate OAuth");
    expect(context).toContain("Fix callback validation");
    expect(context).toContain("Auth debugging thread");
  });

  it("redacts credential-like patterns", () => {
    const context = buildThreadTitleRefreshContext({
      currentTitle: "Auth",
      recentUserIntents: ["api_key: sk-abcdef1234567890 rotate bearer: xyz"],
      compactSummary: null,
    });
    expect(context).not.toContain("sk-abcdef1234567890");
    expect(context).toContain("[redacted]");
  });

  it("bounds output and prefers newest intent", () => {
    const context = buildThreadTitleRefreshContext(
      {
        currentTitle: "T",
        recentUserIntents: ["oldest intent", "middle intent", "newest intent"],
        compactSummary: null,
      },
      60,
    )!;
    expect(context.length).toBeLessThanOrEqual(60);
    expect(context).toContain("newest intent");
  });

  it("never exceeds global cap", () => {
    const context = buildThreadTitleRefreshContext({
      currentTitle: "T".repeat(500),
      recentUserIntents: ["a".repeat(3000)],
      compactSummary: "s".repeat(3000),
    })!;
    expect(context.length).toBeLessThanOrEqual(THREAD_TITLE_REFRESH_CONTEXT_MAX_CHARS);
  });
});
