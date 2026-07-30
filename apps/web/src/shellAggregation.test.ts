// FILE: shellAggregation.test.ts
// Purpose: Verifies remote shell streams merge into the store keyed by environment.
// Layer: Web transport tests

import { EnvironmentId, ThreadId } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { attachEnvironmentShellStream, createShellAggregator } from "./shellAggregation";
import type { WsEnvironmentClient } from "./wsNativeApi";

const ENVIRONMENT_A = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");
const ENVIRONMENT_B = EnvironmentId.makeUnsafe("bbbbbbbb-2222-4222-8222-222222222222");

/** Minimal client stand-in exposing only the shell-event hook the aggregator uses. */
function makeClient(environmentId: EnvironmentId) {
  const listeners = new Set<(item: unknown) => void>();
  const client = {
    environmentId,
    api: {
      orchestration: {
        onShellEvent(listener: (item: unknown) => void) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
  } as unknown as WsEnvironmentClient;
  return {
    client,
    emitSnapshot(snapshotSequence: number, threadId: ThreadId) {
      for (const listener of listeners) {
        listener({ kind: "snapshot", snapshot: { snapshotSequence, threads: [{ id: threadId }] } });
      }
    },
    emitEvent(sequence: number) {
      for (const listener of listeners) {
        listener({ kind: "thread-removed", sequence, threadId: ThreadId.makeUnsafe("x") });
      }
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

describe("shellAggregation", () => {
  it("routes each environment's snapshot to the store under its own id", () => {
    const store = { syncServerShellSnapshot: vi.fn() };
    const a = makeClient(ENVIRONMENT_A);
    const b = makeClient(ENVIRONMENT_B);
    attachEnvironmentShellStream(a.client, store);
    attachEnvironmentShellStream(b.client, store);

    // Both servers emit snapshot sequence 1 — unrelated counters, both must land.
    a.emitSnapshot(1, ThreadId.makeUnsafe("thread-a"));
    b.emitSnapshot(1, ThreadId.makeUnsafe("thread-b"));

    expect(store.syncServerShellSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ snapshotSequence: 1 }),
      ENVIRONMENT_A,
    );
    expect(store.syncServerShellSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ snapshotSequence: 1 }),
      ENVIRONMENT_B,
    );
  });

  it("drops incremental shell events, which are not environment-keyed in the store", () => {
    const store = { syncServerShellSnapshot: vi.fn() };
    const a = makeClient(ENVIRONMENT_A);
    attachEnvironmentShellStream(a.client, store);

    a.emitEvent(5);

    // Applying one would write into whichever environment holds that thread id.
    expect(store.syncServerShellSnapshot).not.toHaveBeenCalled();
  });

  it("detaches when the stream is released", () => {
    const store = { syncServerShellSnapshot: vi.fn() };
    const a = makeClient(ENVIRONMENT_A);
    const detach = attachEnvironmentShellStream(a.client, store);

    detach();
    a.emitSnapshot(1, ThreadId.makeUnsafe("thread-a"));

    expect(store.syncServerShellSnapshot).not.toHaveBeenCalled();
    expect(a.listenerCount).toBe(0);
  });

  it("never attaches the local environment, which the root route already streams", () => {
    const store = { syncServerShellSnapshot: vi.fn() };
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const aggregator = createShellAggregator(store);

    aggregator.sync([local.client]);
    local.emitSnapshot(1, ThreadId.makeUnsafe("thread-local"));

    // Double-applying the local shell is the failure this guards against.
    expect(aggregator.attachedCount).toBe(0);
    expect(store.syncServerShellSnapshot).not.toHaveBeenCalled();
  });

  it("attaches new environments and detaches removed ones without touching the rest", () => {
    const store = { syncServerShellSnapshot: vi.fn() };
    const a = makeClient(ENVIRONMENT_A);
    const b = makeClient(ENVIRONMENT_B);
    const aggregator = createShellAggregator(store);

    aggregator.sync([a.client]);
    aggregator.sync([a.client, b.client]);
    expect(aggregator.attachedCount).toBe(2);
    // Re-syncing must not double-subscribe an already-attached environment.
    aggregator.sync([a.client, b.client]);
    expect(a.listenerCount).toBe(1);

    aggregator.sync([b.client]);
    expect(aggregator.attachedCount).toBe(1);
    expect(a.listenerCount).toBe(0);

    b.emitSnapshot(3, ThreadId.makeUnsafe("thread-b"));
    expect(store.syncServerShellSnapshot).toHaveBeenCalledWith(expect.anything(), ENVIRONMENT_B);
  });
});
