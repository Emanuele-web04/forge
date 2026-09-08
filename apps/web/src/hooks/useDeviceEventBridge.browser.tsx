import type { DeviceEvent, DeviceUdid, ThreadDeviceState } from "@synara/contracts";
import { ThreadId } from "@synara/contracts";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const transport = vi.hoisted(() => ({
  listener: null as ((event: DeviceEvent) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => ({
    device: {
      onEvent: (listener: (event: DeviceEvent) => void) => {
        transport.listener = listener;
        return () => {
          transport.listener = null;
          transport.unsubscribe();
        };
      },
    },
  }),
}));

import { routeSingleDockPaneOpenRequest } from "~/components/chat/dockPaneOpenRequest";
import { useDeviceStateStore } from "~/deviceStateStore";
import { selectRightDockState, useRightDockStore } from "~/rightDockStore";
import { useDeviceEventBridge, useDevicePaneOpenRequests } from "./useDeviceEventBridge";

const THREAD_A = ThreadId.makeUnsafe("thread-a");
const THREAD_B = ThreadId.makeUnsafe("thread-b");
const hydrate = vi.fn();

function ChatSurface({ enabled, threadId }: { enabled: boolean; threadId: ThreadId }) {
  const dock = useRightDockStore(selectRightDockState(threadId));
  const devicePane = dock.panes.find((pane) => pane.kind === "device");
  useDevicePaneOpenRequests({
    onOpenPaneRequested: enabled
      ? (event) =>
          routeSingleDockPaneOpenRequest({
            currentThreadId: threadId,
            requestedThreadId: event.threadId,
            requestImmediateHydration: hydrate,
            openPane: (owner: ThreadId) =>
              useRightDockStore.getState().openPane(owner, { kind: "device" }),
          })
      : null,
  });
  return (
    <>
      <p>Current thread: {threadId}</p>
      {dock.open && devicePane ? (
        <button onClick={() => useRightDockStore.getState().closePane(threadId, devicePane.id)}>
          Close simulator pane
        </button>
      ) : null}
    </>
  );
}

function Harness() {
  useDeviceEventBridge();
  const [enabled, setEnabled] = useState(false);
  const [showChat, setShowChat] = useState(true);
  const [threadId, setThreadId] = useState(THREAD_A);
  return (
    <>
      <button onClick={() => setEnabled(!enabled)}>{enabled ? "Disable" : "Enable"}</button>
      <button onClick={() => setShowChat(!showChat)}>
        {showChat ? "Settings" : "Return to chat"}
      </button>
      <button onClick={() => setThreadId(THREAD_B)}>View thread B</button>
      {showChat ? <ChatSurface enabled={enabled} threadId={threadId} /> : null}
    </>
  );
}

function emitOpen(threadId = THREAD_A) {
  transport.listener?.({
    type: "device.open-pane-requested",
    threadId,
    udid: "device-1" as DeviceUdid,
    reason: "agent-launch",
  });
}

beforeEach(() => {
  useDeviceStateStore.getState().clear();
  useRightDockStore.setState({ dockStateByThreadId: {} });
  transport.unsubscribe.mockClear();
  hydrate.mockClear();
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("device pane request delivery", () => {
  it("replays an ignored request once after enabling and respects a later manual close", async () => {
    const mounted = await render(<Harness />);
    const state = {
      threadId: THREAD_A,
      version: 1,
      attachedDeviceUdid: "device-1" as DeviceUdid,
      devices: [],
      agentActive: true,
      availability: { kind: "available" },
      lastError: null,
    } satisfies ThreadDeviceState;
    transport.listener?.({ type: "device.thread-state", state });
    emitOpen();
    expect(useDeviceStateStore.getState().threadStatesByThreadId[THREAD_A]).toEqual(state);
    await expect
      .element(mounted.getByRole("button", { name: "Close simulator pane" }))
      .not.toBeInTheDocument();
    expect(hydrate).not.toHaveBeenCalled();

    // There is no second server request: DeviceManager suppresses it for this device.
    await mounted.getByRole("button", { name: "Enable", exact: true }).click();
    await expect
      .element(mounted.getByRole("button", { name: "Close simulator pane" }))
      .toBeVisible();
    expect(hydrate).toHaveBeenCalledOnce();
    await mounted.getByRole("button", { name: "Close simulator pane" }).click();
    await mounted.getByRole("button", { name: "Disable", exact: true }).click();
    await mounted.getByRole("button", { name: "Enable", exact: true }).click();
    await mounted.getByRole("button", { name: "Settings", exact: true }).click();
    await mounted.getByRole("button", { name: "Return to chat" }).click();
    await expect
      .element(mounted.getByRole("button", { name: "Close simulator pane" }))
      .not.toBeInTheDocument();
    expect(hydrate).toHaveBeenCalledOnce();
    await mounted.unmount();
    expect(transport.unsubscribe).toHaveBeenCalledOnce();
  });

  it("captures requests during settings and restores the owning thread without switching chats", async () => {
    const mounted = await render(<Harness />);
    await mounted.getByRole("button", { name: "Settings", exact: true }).click();
    emitOpen(THREAD_B);
    await mounted.getByRole("button", { name: "Enable", exact: true }).click();
    await mounted.getByRole("button", { name: "Return to chat" }).click();
    await expect.element(mounted.getByText("Current thread: thread-a")).toBeVisible();
    await expect
      .element(mounted.getByRole("button", { name: "Close simulator pane" }))
      .not.toBeInTheDocument();
    expect(hydrate).not.toHaveBeenCalled();

    await mounted.getByRole("button", { name: "View thread B" }).click();
    await expect
      .element(mounted.getByRole("button", { name: "Close simulator pane" }))
      .toBeVisible();
    await mounted.unmount();
  });
});
