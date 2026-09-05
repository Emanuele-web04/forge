// Purpose: Verify watcher scope, burst coalescing, and native resource release.
import { EventEmitter } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Effect, Stream } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { watchWorkspaceFile } from "./workspaceFileChanges";

const { watchMock } = vi.hoisted(() => ({ watchMock: vi.fn() }));
vi.mock("node:fs", () => ({ watch: watchMock }));

let workspaceRoot: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  vi.resetAllMocks();
  if (workspaceRoot) await fs.rm(workspaceRoot, { recursive: true, force: true });
  workspaceRoot = undefined;
});

it("watches only one parent, coalesces a burst at 100ms, and closes on cancellation", async () => {
  workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "synara-watch-lifecycle-"));
  await fs.writeFile(path.join(workspaceRoot, "target.ts"), "contents");
  let notify: ((kind: string, filename: string | null) => void) | undefined;
  class TestWatcher extends EventEmitter implements FSWatcher {
    close = vi.fn();
    ref(): this {
      return this;
    }
    unref(): this {
      return this;
    }
  }
  const watcher = new TestWatcher();
  watchMock.mockImplementation((_directory: string, _options: unknown, callback: typeof notify) => {
    notify = callback;
    return watcher;
  });
  vi.useFakeTimers();
  const events: unknown[] = [];
  const controller = new AbortController();
  const running = Effect.runPromise(
    watchWorkspaceFile({ cwd: workspaceRoot, relativePath: "target.ts" }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }),
      ),
    ),
    { signal: controller.signal },
  ).catch(() => undefined);
  try {
    await vi.waitFor(() => expect(notify).toBeDefined());
    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(watch).toHaveBeenCalledExactlyOnceWith(
      await fs.realpath(workspaceRoot),
      { recursive: false },
      expect.any(Function),
    );
    notify?.("change", "sibling.ts");
    await vi.advanceTimersByTimeAsync(150);
    expect(events).toHaveLength(1);
    notify?.("change", "target.ts");
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toHaveLength(1);
    notify?.("rename", "target.ts");
    await vi.advanceTimersByTimeAsync(99);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(events).toHaveLength(2));
  } finally {
    controller.abort();
    await running;
  }
  expect(watcher.close).toHaveBeenCalledOnce();
  expect(watcher.listenerCount("error")).toBe(0);
  expect(watcher.listenerCount("close")).toBe(0);
});
