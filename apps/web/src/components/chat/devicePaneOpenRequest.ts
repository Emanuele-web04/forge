import type { ThreadId } from "@synara/contracts";

interface SingleDevicePaneOpenRequestInput {
  readonly currentThreadId: ThreadId;
  readonly requestedThreadId: ThreadId;
  readonly requestImmediateDeviceHydration: () => void;
  readonly openDevicePane: (threadId: ThreadId) => void;
}

/**
 * Remember the pane on its owning thread so background simulator activity never
 * changes the user's current chat. The device runtime stays attached server-side.
 */
export function routeSingleDevicePaneOpenRequest(input: SingleDevicePaneOpenRequestInput): void {
  if (input.requestedThreadId === input.currentThreadId) {
    // Only hydrate the visible thread. Same-thread requests must not wait for
    // rAF, which Chromium suspends for backgrounded windows.
    input.requestImmediateDeviceHydration();
  }

  input.openDevicePane(input.requestedThreadId);
}
