// FILE: threadStreamAggregation.test.ts
// Purpose: Proves a REMOTE thread's stream is actually consumed, and that a
//          replaced client is re-subscribed rather than silently dropped.
// Layer: Web transport aggregation tests

import { EnvironmentId, type OrchestrationThreadStreamItem } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_ENVIRONMENT_ID } from "./environmentIdentity";
import { createThreadStreamAggregator } from "./threadStreamAggregation";
import type { WsEnvironmentClient } from "./wsNativeApi";

const REMOTE_ENVIRONMENT_ID = EnvironmentId.makeUnsafe("aaaaaaaa-1111-4111-8111-111111111111");

/** A client whose thread stream can be driven by the test. */
function makeClient(environmentId: EnvironmentId) {
  const listeners = new Set<(item: OrchestrationThreadStreamItem) => void>();
  const detach = vi.fn();
  const client = {
    environmentId,
    api: {
      orchestration: {
        onThreadEvent: vi.fn((listener: (item: OrchestrationThreadStreamItem) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
            detach();
          };
        }),
      },
    },
  } as unknown as WsEnvironmentClient;
  return {
    client,
    detach,
    listenerCount: () => listeners.size,
    emit(item: OrchestrationThreadStreamItem) {
      for (const listener of listeners) listener(item);
    },
  };
}

const ITEM = { kind: "event", event: { sequence: 1 } } as unknown as OrchestrationThreadStreamItem;

describe("thread stream aggregation", () => {
  it("delivers a REMOTE environment's thread events to the handler", () => {
    // The bug this closes: `subscribeThread` routes to the owning host, so a
    // remote thread's events arrive on THAT connection. Listening only on the
    // local client delivered them to a socket nobody read — the chat rendered
    // empty with no error, because nothing failed.
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const remote = makeClient(REMOTE_ENVIRONMENT_ID);
    const onItem = vi.fn();

    const aggregator = createThreadStreamAggregator(onItem);
    aggregator.sync([local.client, remote.client]);
    remote.emit(ITEM);

    expect(onItem).toHaveBeenCalledTimes(1);
    expect(onItem).toHaveBeenCalledWith(ITEM);
  });

  it("still delivers the LOCAL environment's events", () => {
    // The local stream is not a special case here — this aggregator is the only
    // thread-stream listener, so dropping local would break every chat.
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const onItem = vi.fn();

    createThreadStreamAggregator(onItem).sync([local.client]);
    local.emit(ITEM);

    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("does not double-deliver when sync runs again with the same clients", () => {
    // Registry changes re-run sync constantly. Re-subscribing an already
    // attached client would apply every event twice, and thread detail is not
    // idempotent under duplicate sequences.
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const onItem = vi.fn();

    const aggregator = createThreadStreamAggregator(onItem);
    aggregator.sync([local.client]);
    aggregator.sync([local.client]);
    aggregator.sync([local.client]);
    local.emit(ITEM);

    expect(local.listenerCount()).toBe(1);
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes when a client is REPLACED under the same environment id", () => {
    // A logout disposes the transport without deregistering, so the registry
    // hands back a new client object under the same id. Keying on the id alone
    // makes the replacement look already-attached, and that environment's
    // threads silently stop updating — the exact defect the shell aggregator
    // had to fix.
    const original = makeClient(REMOTE_ENVIRONMENT_ID);
    const replacement = makeClient(REMOTE_ENVIRONMENT_ID);
    const onItem = vi.fn();

    const aggregator = createThreadStreamAggregator(onItem);
    aggregator.sync([original.client]);
    aggregator.sync([replacement.client]);

    expect(original.detach).toHaveBeenCalledTimes(1);
    replacement.emit(ITEM);
    expect(onItem).toHaveBeenCalledTimes(1);
  });

  it("detaches an environment that has gone away", () => {
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const remote = makeClient(REMOTE_ENVIRONMENT_ID);
    const onItem = vi.fn();

    const aggregator = createThreadStreamAggregator(onItem);
    aggregator.sync([local.client, remote.client]);
    aggregator.sync([local.client]);

    expect(remote.detach).toHaveBeenCalledTimes(1);
    remote.emit(ITEM);
    expect(onItem).not.toHaveBeenCalled();
  });

  it("detachAll releases every environment", () => {
    const local = makeClient(LOCAL_ENVIRONMENT_ID);
    const remote = makeClient(REMOTE_ENVIRONMENT_ID);

    const aggregator = createThreadStreamAggregator(vi.fn());
    aggregator.sync([local.client, remote.client]);
    aggregator.detachAll();

    expect(local.detach).toHaveBeenCalledTimes(1);
    expect(remote.detach).toHaveBeenCalledTimes(1);
  });
});
