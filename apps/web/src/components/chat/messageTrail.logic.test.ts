import { MessageId } from "@synara/contracts";
import { describe, expect, it } from "vitest";
import type { TimelineEntry } from "../../session-logic";
import {
  clampNumber,
  clampTooltipTop,
  computeFocusedIndex,
  computeGaussianWeights,
  computeRestStyles,
  computeSigma,
  computeTickStyles,
  computeTrailGeometry,
  createActiveTrailStore,
  deriveMessageTrailItems,
  resolveActiveTrailMessageId,
  resolveActiveTrailSnapshot,
  type MessageTrailAnchor,
  type TrailGeometry,
} from "./messageTrail.logic";

function messageEntry(
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  attachmentCount = 0,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: "2026-01-01T00:00:00Z",
    message: {
      id: MessageId.makeUnsafe(id),
      role,
      text,
      streaming: false,
      turnId: null,
      createdAt: "2026-01-01T00:00:00Z",
      ...(attachmentCount > 0
        ? { attachments: Array.from({ length: attachmentCount }, () => ({}) as never) }
        : {}),
    },
  } as TimelineEntry;
}

function workEntry(id: string): TimelineEntry {
  return {
    id,
    kind: "work",
    createdAt: "2026-01-01T00:00:00Z",
    entry: {} as never,
  } as TimelineEntry;
}

function anchor(id: string, rowIndex: number): MessageTrailAnchor {
  return { id: MessageId.makeUnsafe(id), rowIndex };
}

describe("deriveMessageTrailItems", () => {
  it("keeps only user messages, in order, with sequential ordinals", () => {
    const items = deriveMessageTrailItems([
      messageEntry("u1", "user", "first"),
      messageEntry("a1", "assistant", "reply"),
      workEntry("w1"),
      messageEntry("u2", "user", "second"),
      messageEntry("s1", "system", "system note"),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      MessageId.makeUnsafe("u1"),
      MessageId.makeUnsafe("u2"),
    ]);
    expect(items.map((item) => item.ordinal)).toEqual([1, 2]);
  });

  it("collapses whitespace and caps very long previews", () => {
    const [single] = deriveMessageTrailItems([
      messageEntry("u1", "user", "  hello\n\n   world\t! "),
    ]);
    expect(single?.preview).toBe("hello world !");

    const long = "x".repeat(400);
    const [capped] = deriveMessageTrailItems([messageEntry("u2", "user", long)]);
    expect(capped?.preview.endsWith("…")).toBe(true);
    expect(capped?.preview.length).toBeLessThanOrEqual(281);
  });

  it("reports attachment counts", () => {
    const [item] = deriveMessageTrailItems([messageEntry("u1", "user", "look", 3)]);
    expect(item?.attachmentCount).toBe(3);
  });

  it("captures the turn's final assistant message (end-of-turn reply, not the preamble)", () => {
    const items = deriveMessageTrailItems([
      messageEntry("u1", "user", "first question"),
      messageEntry("a1", "assistant", "  opening   preamble "),
      messageEntry("a2", "assistant", "final answer after the work"),
      messageEntry("u2", "user", "second question"),
      messageEntry("s1", "system", "system note"),
      messageEntry("u3", "user", "third question"),
    ]);

    // Last reply per turn wins (a2, not the a1 preamble); turns with no reply stay empty.
    expect(items.map((item) => item.responsePreview)).toEqual([
      "final answer after the work",
      "",
      "",
    ]);
  });

  it("ignores a trailing empty assistant row so the last real reply stays the end-of-turn text", () => {
    const [item] = deriveMessageTrailItems([
      messageEntry("u1", "user", "ask"),
      messageEntry("a1", "assistant", "preamble"),
      messageEntry("a2", "assistant", "real final reply"),
      messageEntry("a3", "assistant", "   "),
    ]);
    expect(item?.responsePreview).toBe("real final reply");
  });

  it("returns the same items reference for the same entries array", () => {
    const entries = [messageEntry("u1", "user", "ask"), messageEntry("a1", "assistant", "reply")];

    expect(deriveMessageTrailItems(entries)).toBe(deriveMessageTrailItems(entries));
  });

  it("reflects a mid-list message replacement despite the per-message preview cache", () => {
    const unchangedUser = messageEntry("u1", "user", "  first   question ");
    const before = deriveMessageTrailItems([
      unchangedUser,
      messageEntry("a1", "assistant", "old reply"),
      messageEntry("u2", "user", "second question"),
    ]);
    // New entries array with the middle message replaced by a new object — the
    // store never mutates messages in place, so a text change means a new object.
    const after = deriveMessageTrailItems([
      unchangedUser,
      messageEntry("a1", "assistant", "  corrected   reply "),
      messageEntry("u2", "user", "second question"),
    ]);

    expect(before.map((item) => item.responsePreview)).toEqual(["old reply", ""]);
    expect(after.map((item) => item.responsePreview)).toEqual(["corrected reply", ""]);
    expect(after.map((item) => item.preview)).toEqual(["first question", "second question"]);
  });
});

describe("resolveActiveTrailMessageId", () => {
  const anchors = [anchor("u1", 0), anchor("u2", 4), anchor("u3", 9)];

  it("returns null when there are no anchors", () => {
    expect(resolveActiveTrailMessageId([], 5)).toBeNull();
  });

  it("returns the last anchor at or above the topmost visible row", () => {
    expect(resolveActiveTrailMessageId(anchors, 0)).toBe(MessageId.makeUnsafe("u1"));
    expect(resolveActiveTrailMessageId(anchors, 3)).toBe(MessageId.makeUnsafe("u1"));
    expect(resolveActiveTrailMessageId(anchors, 4)).toBe(MessageId.makeUnsafe("u2"));
    expect(resolveActiveTrailMessageId(anchors, 12)).toBe(MessageId.makeUnsafe("u3"));
  });

  it("updates in both scroll directions from the current top visible row", () => {
    const scrollPath = [0, 3, 4, 8, 9, 12, 8, 4, 3, 0];

    expect(scrollPath.map((rowIndex) => resolveActiveTrailMessageId(anchors, rowIndex))).toEqual([
      MessageId.makeUnsafe("u1"),
      MessageId.makeUnsafe("u1"),
      MessageId.makeUnsafe("u2"),
      MessageId.makeUnsafe("u2"),
      MessageId.makeUnsafe("u3"),
      MessageId.makeUnsafe("u3"),
      MessageId.makeUnsafe("u2"),
      MessageId.makeUnsafe("u2"),
      MessageId.makeUnsafe("u1"),
      MessageId.makeUnsafe("u1"),
    ]);
  });

  it("falls back to the first anchor when the viewport sits above it", () => {
    expect(resolveActiveTrailMessageId([anchor("u1", 2), anchor("u2", 5)], 0)).toBe(
      MessageId.makeUnsafe("u1"),
    );
  });
});

describe("resolveActiveTrailSnapshot", () => {
  const anchors = [anchor("u1", 0), anchor("u2", 4), anchor("u3", 9), anchor("u4", 14)];

  it("returns the current anchor plus every sent message visible in the viewport", () => {
    expect(resolveActiveTrailSnapshot(anchors, 3, 10)).toEqual({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u2"), MessageId.makeUnsafe("u3")],
    });
  });

  it("keeps the current anchor even when no sent-message row is directly visible", () => {
    expect(resolveActiveTrailSnapshot(anchors, 5, 8)).toEqual({
      currentId: MessageId.makeUnsafe("u2"),
      visibleIds: [],
    });
  });

  it("tracks visible sent messages as the viewport moves up and down", () => {
    expect([
      resolveActiveTrailSnapshot(anchors, 0, 4).visibleIds,
      resolveActiveTrailSnapshot(anchors, 4, 14).visibleIds,
      resolveActiveTrailSnapshot(anchors, 0, 4).visibleIds,
    ]).toEqual([
      [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
      [MessageId.makeUnsafe("u2"), MessageId.makeUnsafe("u3"), MessageId.makeUnsafe("u4")],
      [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    ]);
  });
});

describe("createActiveTrailStore", () => {
  it("notifies subscribers only when the value actually changes", () => {
    const store = createActiveTrailStore();
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });

    expect(store.get()).toEqual({ currentId: null, visibleIds: [] });

    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    });
    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    }); // duplicate snapshot — no notification
    expect(store.get()).toEqual({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u1"), MessageId.makeUnsafe("u2")],
    });
    expect(notifications).toBe(1);

    store.set({
      currentId: MessageId.makeUnsafe("u1"),
      visibleIds: [MessageId.makeUnsafe("u2")],
    });
    expect(notifications).toBe(2);

    store.set(null);
    expect(store.get()).toEqual({ currentId: null, visibleIds: [] });
    expect(notifications).toBe(3);

    unsubscribe();
    store.set({ currentId: MessageId.makeUnsafe("u3"), visibleIds: [] });
    expect(notifications).toBe(3);
    expect(store.get()).toEqual({ currentId: MessageId.makeUnsafe("u3"), visibleIds: [] });
  });
});

const allFinite = (values: readonly number[]) => values.every((v) => Number.isFinite(v));

describe("computeTrailGeometry", () => {
  it("returns null for N=0", () => {
    expect(computeTrailGeometry({ count: 0 })).toBeNull();
  });

  it("places a single tick at the top padding with no spacing (N=1)", () => {
    const geom = computeTrailGeometry({ count: 1, paddingPx: 12 });
    expect(geom).toEqual({ startY: 12, spacing: 0, centerYs: [12], contentHeight: 24 });
  });

  it("lays ticks out at the fixed spacing from the top padding (N=2)", () => {
    const geom = computeTrailGeometry({ count: 2, spacingPx: 10, paddingPx: 12 })!;
    expect(geom.spacing).toBe(10);
    expect(geom.startY).toBe(12);
    expect(geom.centerYs).toEqual([12, 22]);
    expect(geom.contentHeight).toBe(34); // 2*12 + 1*10
  });

  it("keeps the spacing fixed for many messages and grows the content height", () => {
    const spacing = 10;
    const padding = 12;
    const count = 200;
    const geom = computeTrailGeometry({ count, spacingPx: spacing, paddingPx: padding })!;
    expect(geom.spacing).toBe(spacing); // never compressed to fit
    expect(geom.centerYs[0]).toBe(padding);
    expect(geom.centerYs[count - 1]).toBe(padding + (count - 1) * spacing);
    expect(geom.contentHeight).toBe(2 * padding + (count - 1) * spacing);
    expect(allFinite(geom.centerYs)).toBe(true);
  });
});

describe("computeSigma", () => {
  it("tracks spacing within the density-aware clamp", () => {
    expect(computeSigma(9)).toBeCloseTo(13.5, 5); // clamp(13.5, min(18,8)=8, 22)
    expect(computeSigma(2)).toBeCloseTo(4, 5); // clamp(3, min(4,8)=4, 22) -> floor wins
    expect(computeSigma(0.5)).toBeCloseTo(1, 5); // clamp(0.75, min(1,8)=1, 22) -> 1
    expect(computeSigma(20)).toBeCloseTo(22, 5); // clamp(30, 8, 22) -> upper cap
  });
});

describe("computeGaussianWeights", () => {
  const centerYs = [0, 10, 20, 30, 40];

  it("peaks at exactly 1 under the pointer and stays within [0,1]", () => {
    const weights = computeGaussianWeights(centerYs, 20, 7);
    expect(weights[2]).toBe(1);
    expect(weights.every((w) => w >= 0 && w <= 1)).toBe(true);
  });

  it("is symmetric around the pointer", () => {
    const weights = computeGaussianWeights(centerYs, 20, 7);
    expect(weights[1]).toBeCloseTo(weights[3]!, 10);
    expect(weights[0]).toBeCloseTo(weights[4]!, 10);
  });
});

describe("computeTickStyles", () => {
  const baseW = 14;
  const maxW = 34;
  const rest = 0.38;
  const anchor = 0.9;

  it("grows the focused tick to maxW but keeps its rest colour (size changes, not opacity)", () => {
    const [style] = computeTickStyles([1], null, baseW, maxW, rest, anchor);
    expect(style!.width).toBeCloseTo(maxW, 5);
    expect(style!.opacity).toBeCloseTo(rest, 5); // colour never follows the cursor
  });

  it("keeps opacity fixed per state regardless of weight (anchor dark, others rest)", () => {
    // Even the magnified anchor (weight 1) stays at anchor opacity, not brighter.
    const styles = computeTickStyles([1, 0.5, 0], 0, baseW, maxW, rest, anchor);
    expect(styles.map((s) => s.opacity)).toEqual([anchor, rest, rest]);
    expect(styles[0]!.width).toBeCloseTo(maxW, 5);
    expect(styles[2]!.width).toBeCloseTo(baseW, 5);
  });
});

describe("computeRestStyles", () => {
  it("brightens only the anchor tick", () => {
    const styles = computeRestStyles(3, 1, 14, 0.38, 0.9);
    expect(styles.map((s) => s.opacity)).toEqual([0.38, 0.9, 0.38]);
    expect(styles.every((s) => s.width === 14)).toBe(true);
  });

  it("leaves all ticks at rest when there is no anchor", () => {
    const styles = computeRestStyles(2, null, 14, 0.38, 0.9);
    expect(styles.map((s) => s.opacity)).toEqual([0.38, 0.38]);
  });
});

describe("computeFocusedIndex", () => {
  const geom: TrailGeometry = {
    startY: 100,
    spacing: 10,
    centerYs: [100, 110, 120, 130, 140],
    contentHeight: 264,
  };

  it("returns 0 for a single/degenerate rail", () => {
    expect(
      computeFocusedIndex(999, { startY: 50, spacing: 0, centerYs: [50], contentHeight: 100 }),
    ).toBe(0);
  });

  it("maps pointer position to the nearest tick", () => {
    expect(computeFocusedIndex(100, geom)).toBe(0);
    expect(computeFocusedIndex(124, geom)).toBe(2);
    expect(computeFocusedIndex(140, geom)).toBe(4);
  });

  it("clamps out-of-range pointers to the first/last tick (never negative or N)", () => {
    expect(computeFocusedIndex(-500, geom)).toBe(0);
    expect(computeFocusedIndex(99999, geom)).toBe(4);
  });

  it("is finite-safe for a NaN pointer", () => {
    expect(computeFocusedIndex(Number.NaN, geom)).toBe(0);
  });
});

describe("clampTooltipTop", () => {
  it("keeps the tooltip on-screen near the edges and untouched in the middle", () => {
    expect(clampTooltipTop(10, 56, 500, 4)).toBe(32);
    expect(clampTooltipTop(490, 56, 500, 4)).toBe(468);
    expect(clampTooltipTop(250, 56, 500, 4)).toBe(250);
  });
});

describe("clampNumber", () => {
  it("clamps, and is finite-safe / range-safe", () => {
    expect(clampNumber(5, 0, 10)).toBe(5);
    expect(clampNumber(-1, 0, 10)).toBe(0);
    expect(clampNumber(11, 0, 10)).toBe(10);
    expect(clampNumber(Number.NaN, 2, 8)).toBe(2);
    expect(clampNumber(5, 10, 0)).toBe(10); // inverted range -> min
  });
});
