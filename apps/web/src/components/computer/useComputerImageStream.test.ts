import { describe, expect, it } from "vitest";

import { mergeComputerImageStreamStatus } from "./useComputerImageStream";

describe("mergeComputerImageStreamStatus", () => {
  it("keeps the previous object when a frame reports streaming again", () => {
    const previous = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "streaming" })).toBe(previous);
  });

  it("returns the next status when the kind changes", () => {
    const next = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus({ kind: "connecting" }, next)).toBe(next);
  });

  it("keeps the previous error while the message is unchanged, and swaps when it differs", () => {
    const previous = { kind: "error", message: "boom" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "error", message: "boom" })).toBe(
      previous,
    );

    const next = { kind: "error", message: "different" } as const;
    expect(mergeComputerImageStreamStatus(previous, next)).toBe(next);
  });
});
