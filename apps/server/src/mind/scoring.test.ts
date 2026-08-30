import { type MindMemory } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  buildMindRecallDigest,
  computeMemoryDecay,
  MIND_DECAY_LAMBDA,
  rankMindMemories,
} from "./scoring.ts";

const MILLIS_PER_DAY = 1000 * 60 * 60 * 24;

function makeMemory(overrides: Partial<MindMemory> = {}): MindMemory {
  const base: MindMemory = {
    memoryId: "memory:1:abc" as unknown as MindMemory["memoryId"],
    projectId: "project:1" as unknown as MindMemory["projectId"],
    text: "default",
    weight: 1.0,
    accessCount: 0,
    pinned: false,
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z",
  } as MindMemory;
  return { ...base, ...overrides } as MindMemory;
}

describe("computeMemoryDecay", () => {
  it("returns the base weight for pinned memories", () => {
    const now = new Date("2026-08-01T00:00:00.000Z");
    const memory = makeMemory({
      text: "pinned fact",
      weight: 0.5,
      pinned: true,
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(computeMemoryDecay(memory, now)).toBe(0.5);
  });

  it("decays ~95% after 45 days", () => {
    const updatedAt = new Date("2026-06-01T00:00:00.000Z");
    const now = new Date(updatedAt.getTime() + 45 * MILLIS_PER_DAY);
    const memory = makeMemory({
      text: "stale fact",
      weight: 1.0,
      pinned: false,
      updatedAt: updatedAt.toISOString(),
    });

    const expected = 1.0 * Math.exp(-MIND_DECAY_LAMBDA * 45);
    expect(computeMemoryDecay(memory, now)).toBeCloseTo(expected, 3);
    expect(computeMemoryDecay(memory, now)).toBeCloseTo(0.05, 2);
  });

  it("does not decay when now equals updatedAt", () => {
    const now = new Date("2026-06-16T10:00:00.000Z");
    const memory = makeMemory({
      text: "fresh fact",
      weight: 0.8,
      pinned: false,
      updatedAt: now.toISOString(),
    });

    expect(computeMemoryDecay(memory, now)).toBe(0.8);
  });
});

describe("rankMindMemories", () => {
  it("ranks exact token matches above fresh non-matches", () => {
    const now = new Date("2026-06-16T10:00:00.000Z");
    const freshNonMatch = makeMemory({
      text: "something else entirely",
      weight: 1.0,
      accessCount: 0,
      updatedAt: now.toISOString(),
    });
    const oldExactMatch = makeMemory({
      text: "the quick brown fox",
      weight: 1.0,
      accessCount: 0,
      updatedAt: new Date(now.getTime() - 30 * MILLIS_PER_DAY).toISOString(),
    });

    const ranked = rankMindMemories([freshNonMatch, oldExactMatch], "brown fox", now);

    expect(ranked.length).toBe(2);
    expect(ranked[0]!.memory.text).toBe("the quick brown fox");
    expect(ranked[1]!.memory.text).toBe("something else entirely");
    expect(ranked[0]!.rank).toBe(1);
    expect(ranked[1]!.rank).toBe(2);
  });

  it("breaks ties by updatedAt descending", () => {
    const now = new Date("2026-06-16T10:00:00.000Z");
    const older = makeMemory({
      text: "tie older",
      weight: 0.75,
      updatedAt: new Date(now.getTime() - 1 * MILLIS_PER_DAY).toISOString(),
    });
    const newer = makeMemory({
      text: "tie newer",
      weight: 0.75,
      updatedAt: now.toISOString(),
    });

    const ranked = rankMindMemories([older, newer], undefined, now);

    expect(ranked[0]!.memory.text).toBe("tie newer");
    expect(ranked[1]!.memory.text).toBe("tie older");
  });
});

describe("buildMindRecallDigest", () => {
  it("joins top matches and truncates to the max digest size", () => {
    const matches = Array.from({ length: 8 }, (_, i) => ({
      memory: makeMemory({
        text: `Memory number ${i + 1} with enough padding to exceed.`.repeat(5),
        weight: 1.0,
      }),
      rank: i + 1,
    }));

    const digest = buildMindRecallDigest(matches);

    expect(digest.length).toBeLessThanOrEqual(800);
    expect(digest.endsWith("…")).toBe(true);
  });

  it("returns the full join when under the limit", () => {
    const matches = [
      { memory: makeMemory({ text: "short one" }), rank: 1 },
      { memory: makeMemory({ text: "short two" }), rank: 2 },
    ];

    const digest = buildMindRecallDigest(matches);

    expect(digest).toBe("short one\n\nshort two");
  });
});
