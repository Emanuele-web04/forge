// FILE: shellRefreshCoordinator.test.ts
// Purpose: Unit coverage for the shared shell refresh and repairState coordinator.

import type { NativeApi, OrchestrationReadModel } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  requestRepairState,
  shouldAcceptShellSnapshotSequence,
  shouldSkipShellThreadMutation,
} from "./shellRefreshCoordinator";

function makeApi(repairState: () => Promise<OrchestrationReadModel>): NativeApi {
  return {
    orchestration: { repairState },
  } as unknown as NativeApi;
}

function makeReadModel(overrides: Partial<OrchestrationReadModel> = {}): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-07-12T00:00:00.000Z",
    spaces: [],
    projects: [],
    threads: [],
    ...overrides,
  };
}

describe("shouldAcceptShellSnapshotSequence", () => {
  it("accepts any snapshot before the fence is established", () => {
    expect(shouldAcceptShellSnapshotSequence(-1, 0)).toBe(true);
  });

  it("rejects snapshots older than the applied fence and accepts equal or newer", () => {
    expect(shouldAcceptShellSnapshotSequence(5, 4)).toBe(false);
    expect(shouldAcceptShellSnapshotSequence(5, 5)).toBe(true);
    expect(shouldAcceptShellSnapshotSequence(5, 6)).toBe(true);
  });
});

describe("shouldSkipShellThreadMutation", () => {
  it("skips when detail fence is at least as new as the event", () => {
    expect(shouldSkipShellThreadMutation(undefined, 3)).toBe(false);
    expect(shouldSkipShellThreadMutation(2, 3)).toBe(false);
    expect(shouldSkipShellThreadMutation(3, 3)).toBe(true);
    expect(shouldSkipShellThreadMutation(4, 3)).toBe(true);
  });
});

describe("requestRepairState", () => {
  it("returns the repairState result", async () => {
    const readModel = makeReadModel({ snapshotSequence: 42 });
    const api = makeApi(() => Promise.resolve(readModel));

    await expect(requestRepairState(api)).resolves.toBe(readModel);
  });

  it("serializes concurrent callers so only one repairState is in flight at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let index = 0;

    const api = makeApi(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      index += 1;
      return makeReadModel({ snapshotSequence: index });
    });

    const [first, second, third] = await Promise.all([
      requestRepairState(api),
      requestRepairState(api),
      requestRepairState(api),
    ]);

    expect(maxInFlight).toBe(1);
    expect(first.snapshotSequence).toBe(1);
    expect(second.snapshotSequence).toBe(2);
    expect(third.snapshotSequence).toBe(3);
  });

  it("does not start a queued repair when the first fails", async () => {
    const api = makeApi(() => Promise.reject(new Error("server error")));

    await expect(requestRepairState(api)).rejects.toThrow("server error");
  });

  it("queues a caller that arrives while a repair is already in flight", async () => {
    let calls = 0;
    const api = makeApi(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeReadModel({ snapshotSequence: calls });
    });

    const [first, second] = await Promise.all([
      requestRepairState(api),
      new Promise<OrchestrationReadModel>((resolve) => {
        setTimeout(() => {
          resolve(requestRepairState(api));
        }, 0);
      }),
    ]);

    expect(first.snapshotSequence).toBe(1);
    expect(second.snapshotSequence).toBe(2);
    expect(calls).toBe(2);
  });
});
