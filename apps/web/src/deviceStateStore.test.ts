import type { DeviceUdid, ThreadDeviceState } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { beforeEach, describe, expect, it } from "vitest";

import { selectThreadDeviceState, useDeviceStateStore } from "./deviceStateStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-device-1");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("thread-device-2");

function threadState(overrides: Partial<ThreadDeviceState> = {}): ThreadDeviceState {
  return {
    threadId: THREAD_ID,
    version: 1,
    attachedDeviceUdid: null,
    devices: [],
    agentActive: false,
    availability: { kind: "available" },
    lastError: null,
    ...overrides,
  } as ThreadDeviceState;
}

beforeEach(() => {
  useDeviceStateStore.getState().clear();
});

describe("deviceStateStore version gating", () => {
  it("stores the first state for a thread", () => {
    useDeviceStateStore.getState().upsertThreadState(threadState());

    expect(selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState())?.version).toBe(1);
  });

  it("applies a newer version", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState({ version: 1 }));
    store.upsertThreadState(threadState({ version: 2, agentActive: true }));

    const current = selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState());
    expect(current?.version).toBe(2);
    expect(current?.agentActive).toBe(true);
  });

  it("drops a stale push that arrives after a newer one", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(
      threadState({ version: 5, attachedDeviceUdid: "udid-new" as DeviceUdid }),
    );
    store.upsertThreadState(
      threadState({ version: 2, attachedDeviceUdid: "udid-old" as DeviceUdid }),
    );

    const current = selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState());
    expect(current?.version).toBe(5);
    expect(current?.attachedDeviceUdid).toBe("udid-new");
  });

  it("drops a repeat of the current version", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState({ version: 3, agentActive: true }));
    const before = selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState());

    store.upsertThreadState(threadState({ version: 3, agentActive: false }));
    const after = selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState());

    expect(after).toBe(before);
    expect(after?.agentActive).toBe(true);
  });

  it("versions each thread independently", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState({ threadId: THREAD_ID, version: 9 }));
    store.upsertThreadState(threadState({ threadId: OTHER_THREAD_ID, version: 1 }));

    const state = useDeviceStateStore.getState();
    expect(selectThreadDeviceState(THREAD_ID)(state)?.version).toBe(9);
    expect(selectThreadDeviceState(OTHER_THREAD_ID)(state)?.version).toBe(1);
  });

  it("removes a thread without touching its neighbours", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState({ threadId: THREAD_ID }));
    store.upsertThreadState(threadState({ threadId: OTHER_THREAD_ID }));

    useDeviceStateStore.getState().removeThreadState(THREAD_ID);

    const state = useDeviceStateStore.getState();
    expect(selectThreadDeviceState(THREAD_ID)(state)).toBeUndefined();
    expect(selectThreadDeviceState(OTHER_THREAD_ID)(state)).toBeDefined();
  });

  it("keeps the same object identity when removing an unknown thread", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState());
    const before = useDeviceStateStore.getState().threadStatesByThreadId;

    useDeviceStateStore.getState().removeThreadState(OTHER_THREAD_ID);

    expect(useDeviceStateStore.getState().threadStatesByThreadId).toBe(before);
  });

  it("re-accepts a lower version after the thread is removed", () => {
    const store = useDeviceStateStore.getState();
    store.upsertThreadState(threadState({ version: 7 }));
    useDeviceStateStore.getState().removeThreadState(THREAD_ID);
    useDeviceStateStore.getState().upsertThreadState(threadState({ version: 1 }));

    expect(selectThreadDeviceState(THREAD_ID)(useDeviceStateStore.getState())?.version).toBe(1);
  });
});
