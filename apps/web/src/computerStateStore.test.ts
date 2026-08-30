import type { ThreadComputerState, ThreadId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  selectThreadComputerAction,
  selectThreadComputerState,
  useComputerStateStore,
} from "./computerStateStore";

const FULL_CAPABILITIES: ThreadComputerState["capabilities"] = {
  windows: true,
  windowBounds: true,
  stacking: true,
  capture: true,
  input: true,
  clipboard: true,
  activation: true,
  ghostCursor: true,
  visibleDesktop: true,
};

const baseState: ThreadComputerState = {
  threadId: "thread-1" as ThreadId,
  version: 2,
  computerId: "desktop",
  capabilities: FULL_CAPABILITIES,
  windows: [],
  screenSize: { width: 5120, height: 2520 },
  agentActive: false,
  controlledByOtherThread: false,
  availability: { kind: "available" },
  health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
  lastError: null,
};

describe("computerStateStore", () => {
  it("keeps the newest thread snapshot and exposes its selector", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    useComputerStateStore
      .getState()
      .upsertThreadState({ ...baseState, version: 1, agentActive: true });

    expect(
      selectThreadComputerState("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toEqual(baseState);
  });

  it("takes a newer snapshot's degraded health", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    const degraded: ThreadComputerState = {
      ...baseState,
      version: 3,
      availability: { kind: "backend-unavailable", message: "Reconnecting to the desktop." },
      health: {
        status: "reconnecting",
        consecutiveFailures: 1,
        reconnects: 0,
        lastFailure: { message: "The backend vanished", at: "2026-08-16T10:00:00.000Z" },
        captureAvailable: false,
      },
    };

    useComputerStateStore.getState().upsertThreadState(degraded);

    expect(
      selectThreadComputerState("thread-1" as ThreadId)(useComputerStateStore.getState())?.health,
    ).toEqual(degraded.health);
  });

  it("applies window changes and records the latest action", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    const window = {
      id: "window-1",
      title: "Terminal",
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      focused: true,
      minimized: false,
      visible: true,
    };
    useComputerStateStore.getState().applyWindowsChanged([window]);
    const action = { type: "computer.action", action: "click", ok: true } as const;
    useComputerStateStore.getState().recordAction(action);

    expect(useComputerStateStore.getState().threadStatesByThreadId["thread-1"]?.windows).toEqual([
      window,
    ]);
    expect(useComputerStateStore.getState().lastAction).toEqual(action);
  });

  it("attributes an action to its thread and leaves other threads untouched", () => {
    useComputerStateStore.getState().clear();
    const typed = {
      type: "computer.action",
      action: "computer_type_text",
      ok: true,
      threadId: "thread-1" as ThreadId,
    } as const;
    const paneClick = { type: "computer.action", action: "computer_click", ok: true } as const;

    useComputerStateStore.getState().recordAction(typed);
    useComputerStateStore.getState().recordAction(paneClick);

    expect(
      selectThreadComputerAction("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toBe(typed);
    expect(
      selectThreadComputerAction("thread-2" as ThreadId)(useComputerStateStore.getState()),
    ).toBeUndefined();
    // Unattributed pane input still moves the global cursor of activity.
    expect(useComputerStateStore.getState().lastAction).toBe(paneClick);
  });

  it("forgets a removed thread's action along with its snapshot", () => {
    useComputerStateStore.getState().clear();
    useComputerStateStore.getState().upsertThreadState(baseState);
    useComputerStateStore.getState().recordAction({
      type: "computer.action",
      action: "computer_click",
      ok: true,
      threadId: "thread-1" as ThreadId,
    });

    useComputerStateStore.getState().removeThreadState("thread-1" as ThreadId);

    expect(
      selectThreadComputerAction("thread-1" as ThreadId)(useComputerStateStore.getState()),
    ).toBeUndefined();
    expect(useComputerStateStore.getState().threadStatesByThreadId["thread-1"]).toBeUndefined();
  });

  it("clears snapshots and action history", () => {
    useComputerStateStore.getState().clear();
    expect(useComputerStateStore.getState().threadStatesByThreadId).toEqual({});
    expect(useComputerStateStore.getState().lastAction).toBeNull();
    expect(useComputerStateStore.getState().lastActionByThreadId).toEqual({});
  });
});

const OTHER_THREAD_ID = "thread-2" as ThreadId;
const openRequest = (threadId: ThreadId = baseState.threadId) =>
  ({ type: "computer.open-pane-requested", threadId }) as const;

describe("deferred computer pane requests", () => {
  it("keeps the latest request per thread and consumes each once", () => {
    const store = useComputerStateStore.getState();
    store.clear();
    store.queueOpenRequest(openRequest());
    store.queueOpenRequest(openRequest(OTHER_THREAD_ID));
    store.queueOpenRequest(openRequest());

    expect(store.takeOpenRequests()).toEqual([openRequest(), openRequest(OTHER_THREAD_ID)]);
    expect(store.takeOpenRequests()).toEqual([]);
  });

  it("removes pending requests with their thread or server state", () => {
    const store = useComputerStateStore.getState();
    store.clear();
    store.queueOpenRequest(openRequest());
    store.queueOpenRequest(openRequest(OTHER_THREAD_ID));
    store.removeThreadState(baseState.threadId);
    expect(
      useComputerStateStore.getState().pendingOpenRequests[baseState.threadId],
    ).toBeUndefined();
    expect(useComputerStateStore.getState().pendingOpenRequests[OTHER_THREAD_ID]).toBeDefined();

    store.clear();
    expect(store.takeOpenRequests()).toEqual([]);
  });
});
