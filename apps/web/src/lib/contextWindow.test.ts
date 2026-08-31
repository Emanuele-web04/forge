import { describe, expect, it } from "vitest";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@synara/contracts";

import {
  deriveContextWindowSelectionStatus,
  deriveContextWindowMeterDisplay,
  deriveCumulativeCostUsd,
  deriveLatestContextWindowState,
  deriveLatestContextWindowSnapshot,
  deriveSelectedContextWindowSnapshot,
  formatContextWindowSelectionLabel,
  formatContextWindowTokens,
  inferContextWindowSelectionValue,
} from "./contextWindow";

function makeActivity(
  id: string,
  kind: string,
  payload: OrchestrationThreadActivity["payload"],
): OrchestrationThreadActivity {
  return {
    id: EventId.makeUnsafe(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.makeUnsafe("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("invalidates earlier usage at a completed compaction until fresh usage arrives", () => {
    const beforeCompaction = [
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "200k",
        maxTokens: 200_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 180_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-compaction", {
        state: "compacted",
      }),
      makeActivity("activity-4", "context-window.updated", {
        usedTokens: 0,
        totalProcessedTokens: 340_000,
      }),
    ];

    expect(deriveLatestContextWindowSnapshot(beforeCompaction)).toBeNull();
    expect(deriveLatestContextWindowState(beforeCompaction).invalidatedByCompaction).toBe(true);

    const afterFreshUsage = deriveLatestContextWindowSnapshot([
      ...beforeCompaction,
      makeActivity("activity-5", "context-window.updated", {
        usedTokens: 20_000,
        maxTokens: 200_000,
      }),
    ]);

    expect(afterFreshUsage?.usedTokens).toBe(20_000);
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("derives percent-only context window snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(5.8);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBeNull();
    expect(snapshot?.compactsAutomatically).toBe(true);
  });

  it("derives real zero-percent context window snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercent).toBe(0);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("keeps zero-token usage reliable when runtime reports max tokens", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 0,
        maxTokens: 128_000,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.remainingTokens).toBe(128_000);
    expect(deriveContextWindowMeterDisplay(snapshot!)).toMatchObject({
      hasReliableTokenRatio: true,
      tokenUsageLabel: "0",
      compactLabel: "0%",
    });
  });

  it("does not infer remaining tokens from percent-only usage", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
        compactsAutomatically: true,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.usedPercentage).toBe(5.8);
    expect(snapshot?.maxTokens).toBe(1_000_000);
    expect(snapshot?.remainingTokens).toBeNull();
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });

  it("uses the configured session max tokens when usage snapshots lag behind", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(23_000);
    expect(snapshot?.maxTokens).toBe(1_000_000);
  });

  it("falls back to runtime usage after the configured window is cleared", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
      makeActivity("activity-3", "context-window.configured", { cleared: true }),
    ]);

    expect(snapshot?.usedTokens).toBe(23_000);
    expect(snapshot?.maxTokens).toBe(200_000);
  });

  it("returns a session snapshot from configured max tokens before usage arrives", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.maxTokens).toBe(1_000_000);
  });

  it("creates an initial selected context window snapshot before runtime usage arrives", () => {
    const snapshot = deriveSelectedContextWindowSnapshot("1m");

    expect(snapshot?.usedTokens).toBe(0);
    expect(snapshot?.maxTokens).toBe(1_000_000);
    expect(snapshot?.usedPercentage).toBe(0);
  });

  it("derives meter display labels without inventing token ratios", () => {
    const percentOnly = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.configured", {
        contextWindow: "1m",
        maxTokens: 1_000_000,
      }),
      makeActivity("activity-2", "context-window.updated", {
        usedTokens: 0,
        usedPercent: 5.8,
      }),
    ]);

    expect(percentOnly).not.toBeNull();
    expect(deriveContextWindowMeterDisplay(percentOnly!)).toMatchObject({
      usedPercentageLabel: "5.8%",
      tokenUsageLabel: "0",
      hasReliableTokenRatio: false,
      normalizedPercentage: 5.8,
      compactLabel: "6%",
      ariaLabel: "Context window 5.8% used",
    });
  });

  it("formats context window selection labels for Claude options", () => {
    expect(formatContextWindowSelectionLabel("1m")).toBe("1M");
    expect(formatContextWindowSelectionLabel("200k")).toBe("200k");
  });

  it("uses Cursor cumulative cost without summing it as a turn delta", () => {
    expect(
      deriveCumulativeCostUsd([
        makeActivity("turn-1", "turn.completed", {
          cumulativeCostUsd: 0.2,
        }),
        makeActivity("turn-2", "turn.completed", {
          cumulativeCostUsd: 0.25,
        }),
      ]),
    ).toBe(0.25);
  });

  it("infers the active Claude context window from max tokens", () => {
    expect(inferContextWindowSelectionValue(200_000)).toBe("200k");
    expect(inferContextWindowSelectionValue(1_000_000)).toBe("1m");
    expect(inferContextWindowSelectionValue(333_000)).toBeNull();
  });

  it("marks a selected Claude context window as pending when the live session differs", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 23_000,
        maxTokens: 200_000,
      }),
    ]);

    expect(
      deriveContextWindowSelectionStatus({
        activeSnapshot: snapshot,
        selectedValue: "1m",
      }),
    ).toEqual({
      activeLabel: "200k",
      selectedLabel: "1M",
      pendingSelectedLabel: "1M",
    });
  });
});
