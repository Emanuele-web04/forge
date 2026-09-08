import { describe, expect, it } from "vitest";

import {
  DESKTOP_OPERATION_QUEUE_LIMIT,
  DesktopOperationQueue,
  desktopOperationSignal,
} from "./DesktopOperationQueue.ts";

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

it("cancels running native work before completing shutdown", async () => {
  const queue = new DesktopOperationQueue();
  const entered = deferred();
  const running = queue.run(async () => {
    const signal = desktopOperationSignal()!;
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    entered.resolve();
    await aborted;
    expect(signal.aborted).toBe(true);
  });
  await entered.promise;
  await queue.close();
  await running;
});

it("does not retain a cancelled turn's signal in detached background work", async () => {
  const queue = new DesktopOperationQueue();
  const controller = new AbortController();
  const release = deferred();
  let detached!: Promise<AbortSignal | undefined>;
  await queue.run(async () => {
    detached = release.promise.then(() => desktopOperationSignal());
    expect(desktopOperationSignal()?.aborted).toBe(false);
  }, controller.signal);
  controller.abort();
  release.resolve();
  expect(await detached).toBeUndefined();
  await queue.close();
});

it("allows perception during input and waiting without releasing the input lane", async () => {
  const queue = new DesktopOperationQueue();
  const entered = deferred();
  const held = deferred();
  const input = queue.run(async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  expect(await queue.read(async () => "desktop")).toBe("desktop");
  let nextInputRan = false;
  const next = queue.run(async () => {
    nextInputRan = true;
  });
  await Promise.resolve();
  expect(nextInputRan).toBe(false);
  held.resolve();
  await Promise.all([input, next]);
  await queue.close();
});

it("cancels concurrent reads on shutdown and rejects later reads", async () => {
  const queue = new DesktopOperationQueue();
  const entered = deferred();
  const reading = queue.read(async () => {
    const signal = desktopOperationSignal()!;
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    expect(signal.aborted).toBe(true);
  });
  await entered.promise;
  await queue.close();
  await reading;
  await expect(queue.read(async () => undefined)).rejects.toThrow("closed");
});
