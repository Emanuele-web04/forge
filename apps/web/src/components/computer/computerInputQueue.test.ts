import { describe, expect, it } from "vitest";

import { createComputerInputQueue } from "./computerInputQueue";

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe("computer input queue", () => {
  it("runs sends one at a time in order", async () => {
    const started: number[] = [];
    const finished: number[] = [];
    const gates = [deferred(), deferred()];
    const queue = createComputerInputQueue();

    for (const [index, gate] of gates.entries()) {
      queue.push(async () => {
        started.push(index);
        await gate.promise;
        finished.push(index);
      });
    }

    await Promise.resolve();
    expect(started).toEqual([0]);
    expect(queue.pending()).toBe(2);

    gates[0]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([0, 1]);
    expect(finished).toEqual([0]);

    gates[1]?.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(finished).toEqual([0, 1]);
    expect(queue.pending()).toBe(0);
  });

  it("drops input past the backlog limit instead of growing without bound", async () => {
    const gate = deferred();
    const dropped: number[] = [];
    const queue = createComputerInputQueue({ limit: 2, onDrop: () => dropped.push(1) });

    expect(queue.push(() => gate.promise)).toBe(true);
    expect(queue.push(async () => {})).toBe(true);
    expect(queue.push(async () => {})).toBe(false);
    expect(dropped).toHaveLength(1);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(queue.pending()).toBe(0);
    expect(queue.push(async () => {})).toBe(true);
  });

  it("reports a failed send and keeps the queue running", async () => {
    const errors: unknown[] = [];
    const queue = createComputerInputQueue({ onError: (error) => errors.push(error) });
    let ranAfterFailure = false;

    queue.push(async () => {
      throw new Error("seat refused the click");
    });
    queue.push(async () => {
      ranAfterFailure = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
    expect(ranAfterFailure).toBe(true);
  });

  it("clear() drops what has not started and lets the in-flight send finish", async () => {
    const gate = deferred();
    const ran: number[] = [];
    const errors: unknown[] = [];
    const queue = createComputerInputQueue({ onError: (error) => errors.push(error) });

    queue.push(async () => {
      ran.push(0);
      await gate.promise;
    });
    queue.push(async () => {
      ran.push(1);
    });
    queue.push(async () => {
      ran.push(2);
    });
    await Promise.resolve();
    expect(queue.pending()).toBe(3);

    queue.clear();
    expect(queue.pending()).toBe(1);

    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual([0]);
    expect(errors).toEqual([]);
    expect(queue.pending()).toBe(0);

    // The queue is still usable after a clear.
    queue.push(async () => {
      ran.push(3);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toEqual([0, 3]);
  });
});
