import { describe, expect, it } from "vitest";

import { DESKTOP_OPERATION_QUEUE_LIMIT, DesktopOperationQueue } from "./DesktopOperationQueue.ts";

function deferred() {
  return Promise.withResolvers<void>();
}

describe("DesktopOperationQueue", () => {
  it("holds the desktop until input and observation finish, then recovers after a failure", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const events: string[] = [];
    const first = queue.run(async () => {
      await queue.run(async () => {
        events.push("input");
      });
      entered.resolve();
      await held.promise;
      events.push("observation");
      throw new Error("capture failed");
    });
    const failed = expect(first).rejects.toThrow("capture failed");
    await entered.promise;
    const second = queue.run(async () => {
      events.push("next input");
    });
    expect(events).toEqual(["input"]);
    held.resolve();
    await failed;
    await second;
    expect(events).toEqual(["input", "observation", "next input"]);
  });

  it("skips an aborted operation before it can send input", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const first = queue.run(() => held.promise);
    const controller = new AbortController();
    let ran = false;
    const second = queue.run(async () => {
      ran = true;
    }, controller.signal);
    const rejected = expect(second).rejects.toThrow();
    controller.abort();
    held.resolve();
    await first;
    await rejected;
    expect(ran).toBe(false);
  });

  it("bounds the backlog and drains active input before closing", async () => {
    const queue = new DesktopOperationQueue();
    const held = deferred();
    const entered = deferred();
    const first = queue.run(async () => {
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    let queuedRuns = 0;
    const waiting = Array.from({ length: DESKTOP_OPERATION_QUEUE_LIMIT - 1 }, () =>
      expect(
        queue.run(async () => {
          queuedRuns += 1;
        }),
      ).rejects.toThrow("closed"),
    );
    await expect(queue.run(async () => undefined)).rejects.toThrow("Too many");
    const closed = queue.close();
    held.resolve();
    await first;
    await closed;
    await Promise.all(waiting);
    expect(queuedRuns).toBe(0);
    await expect(queue.run(async () => undefined)).rejects.toThrow("closed");
  });
});
