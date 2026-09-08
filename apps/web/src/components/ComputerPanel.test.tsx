// FILE: ComputerPanel.test.tsx
// Purpose: Guards what the Computer pane puts on screen for a given desktop
//          state — the label it gives the canvas, the health badge, the Stop
//          control, the Set up affordance, and the input gating.
// Layer: Component rendering tests
// Depends on: ComputerPanel, the computer state store, and React server rendering.
//
// Rendered to static markup against a fixed thread state. Every side effect in
// this component and its hooks lives in `useEffect`, so a server render
// exercises exactly the render-time decisions — which is the part worth
// pinning, because each of these was a wrong answer once: the canvas said
// "Linux desktop" on a Mac, a lazily-connected backend flashed "Desktop
// unavailable" at every open, and the pane invited clicks into a picture of the
// user's own screen.
//
// The state store is stubbed rather than seeded: zustand serves its *initial*
// state to `useSyncExternalStore`'s server snapshot, so a real store populated
// before the render would still render empty here.

import type { ComputerAvailability, ThreadComputerState, ThreadId } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import ComputerPanel from "./ComputerPanel";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

/** The one thread state every render in this file reads, swapped per test. */
const current: { state: ThreadComputerState | undefined } = vi.hoisted(() => ({
  state: undefined,
}));

vi.mock("../computerStateStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../computerStateStore")>();
  return {
    ...actual,
    useComputerStateStore: (selector: (store: unknown) => unknown) =>
      selector({
        threadStatesByThreadId: current.state ? { [current.state.threadId]: current.state } : {},
        lastActionByThreadId: {},
      }),
  };
});

const THREAD_ID = "thread-1" as ThreadId;

function capabilities(overrides: Partial<ThreadComputerState["capabilities"]> = {}) {
  return {
    windows: true,
    windowBounds: true,
    stacking: true,
    capture: true,
    input: true,
    clipboard: true,
    focus: true,
    raise: true,
    ghostCursor: true,
    visibleDesktop: true,
    ...overrides,
  };
}

function threadState(overrides: Partial<ThreadComputerState> = {}): ThreadComputerState {
  return {
    threadId: THREAD_ID,
    version: 1,
    computerId: "desktop",
    capabilities: capabilities(),
    windows: [],
    screenSize: { width: 5120, height: 2520 },
    agentActive: false,
    controlledByOtherThread: false,
    availability: { kind: "available", backend: "mac" } as ComputerAvailability,
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    lastError: null,
    ...overrides,
  };
}

function render(state?: ThreadComputerState) {
  current.state = state;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerPanel
        mode="sidebar"
        threadId={THREAD_ID}
        runtimeMode="live"
        isVisible
        onClosePanel={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  current.state = undefined;
});

describe("ComputerPanel", () => {
  it("shows the current activity and keeps Stop available during a pause", () => {
    const active = { agentActive: true, activity: "Thinking" };
    expect(render(threadState(active))).toContain("Thinking");
    const markup = render(
      threadState({
        ...active,
        inputPause: { windowId: "7", message: "Return to the window." },
        windows: [
          {
            id: "7",
            title: "Draft",
            appName: "Helium",
            focused: false,
            minimized: true,
            visible: false,
          },
        ],
      }),
    );
    expect(markup).toContain("Input paused — return to Helium");
    expect(markup).toContain("Check again");
    expect(markup).toContain("Stop the agent controlling this computer");
    expect(markup).not.toContain(">Thinking<");
  });

  it("names the desktop the canvas is a picture of", () => {
    // The single most important fact about the surface: whether the agent is
    // driving a sandbox or the machine the user is sitting at.
    expect(render(threadState())).toContain("This Mac&#x27;s desktop");
  });

  it("calls a nested desktop the agent's own", () => {
    const markup = render(
      threadState({
        availability: { kind: "available", backend: "nested-kwin" },
        capabilities: capabilities({ visibleDesktop: false }),
      }),
    );
    expect(markup).toContain("The agent&#x27;s own desktop");
  });

  it("stays quiet about health on a backend that has simply not been engaged yet", () => {
    // The server no longer connects at boot, so the first snapshot a pane sees
    // carries non-connected health with a clean record. Badging that would
    // flash "Desktop unavailable" at every pane open on a healthy desktop.
    const markup = render(
      threadState({
        health: {
          status: "unavailable",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: true,
        },
      }),
    );
    expect(markup).not.toContain("Desktop unavailable");
  });

  it("badges a backend that dropped out", () => {
    const markup = render(
      threadState({
        health: {
          status: "reconnecting",
          consecutiveFailures: 2,
          reconnects: 1,
          captureAvailable: true,
          lastFailure: { message: "the helper exited", at: "2026-09-05T00:00:00.000Z" },
        },
      }),
    );
    expect(markup).toContain("Reconnecting to desktop");
  });

  it("offers Set up in the pane when the OS is withholding a grant", () => {
    const markup = render(
      threadState({
        availability: {
          kind: "permission-required",
          missing: ["accessibility"],
          message: "macOS is asking for Accessibility.",
          buildSignature: "adhoc",
        },
      }),
    );
    expect(markup).toContain("Set up");
    expect(markup).toContain("macOS is asking for Accessibility.");
  });

  it("shows the Stop control while an agent is driving a visible desktop", () => {
    expect(render(threadState({ agentActive: true }))).toContain("Stop");
  });

  it("does not invite the user to click a picture of their own screen", () => {
    // On a visible desktop the pane is a mirror: clicking it means reaching a
    // control the mouse in the user's hand can reach first, with a round trip's
    // staleness in between.
    const visible = render(threadState());
    expect(visible).not.toContain("Click to interact");
    const nested = render(
      threadState({
        availability: { kind: "available", backend: "nested-kwin" },
        capabilities: capabilities({ visibleDesktop: false }),
      }),
    );
    expect(nested).not.toBe(visible);
  });
});

describe("desktop ownership", () => {
  it("keeps Stop visible between tool calls and when another conversation owns the computer", () => {
    const markup = render(
      threadState({
        agentActive: false,
        controlledByOtherThread: true,
        controlOwnerThreadId: "other-thread" as ThreadId,
        controlOwnerLabel: "Research assistant",
      }),
    );
    expect(markup).toContain("Research assistant");
    expect(markup).toContain("Stop");
    expect(markup).toContain("is controlling");
  });
});
