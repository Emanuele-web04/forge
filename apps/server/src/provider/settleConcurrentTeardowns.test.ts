import { Effect, Exit } from "effect";
import { describe, expect, it, vi } from "vitest";

import { settleConcurrentTeardowns } from "./settleConcurrentTeardowns.ts";

describe("settleConcurrentTeardowns", () => {
  it("starts every teardown and waits for settlement before reporting a failure", async () => {
    const failure = new Error("synthetic teardown failure");
    const started: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const result = Effect.runPromiseExit(
      settleConcurrentTeardowns([1, 2, 3], (item) =>
        Effect.tryPromise({
          try: async () => {
            started.push(item);
            await gate;
            if (item === 2) throw failure;
          },
          catch: (cause) => cause as Error,
        }),
      ),
    );

    await vi.waitFor(() => expect(started).toHaveLength(3));
    release();

    const exit = await result;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain(failure.message);
    }
  });
});
