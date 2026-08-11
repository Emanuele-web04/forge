import type { ThreadId } from "@synara/contracts";

interface SingleDevicePaneOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateDeviceHydration: () => void;
  readonly openDevicePane: (threadId: ThreadId) => void;
  readonly navigateToThread: (threadId: ThreadId) => void;
}

/**
 * Mirrors routeSingleBrowserPanelOpenRequest. The event carries its own thread
 * so an agent launching an app on a background thread cannot yank the pane away
 * from whatever the user is currently reading — the dock is seeded there and the
 * route follows.
 */
export function routeSingleDevicePaneOpenRequest(input: SingleDevicePaneOpenRequestInput): void {
  // Agent-triggered opens must not wait for rAF, which Chromium suspends for
  // backgrounded windows.
  input.requestImmediateDeviceHydration();

  if (input.requestedThreadId === input.currentThreadId) {
    input.openDevicePane(input.currentThreadId);
    return;
  }

  input.openDevicePane(input.requestedThreadId);
  input.navigateToThread(input.requestedThreadId);
}
