import { describe, expect, it, vi } from "vitest";

import { createExclusiveApplyQueue } from "./exclusiveApplyQueue";

describe("createExclusiveApplyQueue", () => {
  it("applies values in order when they do not overlap", async () => {
    const applied: string[] = [];
    const enqueue = createExclusiveApplyQueue(async (value: string) => {
      applied.push(value);
    });

    await enqueue("default");
    await enqueue("icon");

    expect(applied).toEqual(["default", "icon"]);
  });

  it("joins an in-flight apply of the same value instead of running it twice", async () => {
    const applied: string[] = [];
    let release: (() => void) | undefined;
    const firstApply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueue = createExclusiveApplyQueue(async (value: string) => {
      applied.push(value);
      if (applied.length === 1) await firstApply;
    });

    const first = enqueue("icon");
    const second = enqueue("icon");
    release?.();
    await Promise.all([first, second]);

    expect(applied).toEqual(["icon"]);
  });

  it("waits for the current apply to finish before starting a different value", async () => {
    const applied: string[] = [];
    let release: (() => void) | undefined;
    const firstApply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const enqueue = createExclusiveApplyQueue(async (value: string) => {
      applied.push(`start:${value}`);
      if (value === "default") await firstApply;
      applied.push(`end:${value}`);
    });

    const first = enqueue("default");
    await vi.waitFor(() => expect(applied).toEqual(["start:default"]));
    const second = enqueue("icon");
    expect(applied).toEqual(["start:default"]);
    release?.();
    await Promise.all([first, second]);

    expect(applied).toEqual(["start:default", "end:default", "start:icon", "end:icon"]);
  });
});
