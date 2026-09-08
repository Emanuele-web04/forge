// FILE: ComputerSettingsPanel.test.tsx
// Purpose: Guards what the Computer settings panel tells the user about the
//          desktop backend — the honest ones, the blocked ones, and the rows it
//          must not render on a backend where they would be inert.
// Layer: Component rendering tests
// Depends on: ComputerSettingsPanel and React server rendering.
//
// Rendered to static markup with the status query primed, which is enough for
// every question worth asking of this panel: it is a read-out, and what it
// reads out is decided at render time. Interaction (pressing Set up) belongs to
// `useProvisionComputer.test.tsx`, which owns that mutation.

import type { ComputerStatusResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { AppSettingsBinding } from "~/appSettings";
import { serverQueryKeys } from "~/lib/serverReactQuery";
import { ComputerSettingsPanel } from "./ComputerSettingsPanel";

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: vi.fn() } }));

function capabilities(overrides: Partial<ComputerStatusResult["capabilities"]> = {}) {
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

function status(overrides: Partial<ComputerStatusResult> = {}): ComputerStatusResult {
  return {
    computerId: "desktop",
    availability: { kind: "available", backend: "mac" },
    capabilities: capabilities(),
    health: { status: "connected", consecutiveFailures: 0, reconnects: 0, captureAvailable: true },
    ...overrides,
  };
}

function binding(): AppSettingsBinding {
  return {
    settings: { autoOpenComputerPane: true, allowComputerControlInNewChats: true },
    defaults: { autoOpenComputerPane: true, allowComputerControlInNewChats: true },
    updateSettings: vi.fn(),
  } as unknown as AppSettingsBinding;
}

function render(input: { readonly status?: ComputerStatusResult; readonly active?: boolean }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (input.status) queryClient.setQueryData(serverQueryKeys.computerStatus(), input.status);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <ComputerSettingsPanel {...binding()} active={input.active ?? true} />
    </QueryClientProvider>,
  );
}

describe("ComputerSettingsPanel", () => {
  it("renders nothing while the panel is not the active one", () => {
    // The status query is gated on the same flag; a panel nobody is looking at
    // must not poll a backend awake.
    expect(render({ status: status(), active: false })).toBe("");
  });

  it("names the backend rather than the raw identifier", () => {
    expect(render({ status: status() })).toContain("macOS desktop");
    expect(
      render({ status: status({ availability: { kind: "available", backend: "kwin" } }) }),
    ).toContain("KWin plugin (KDE)");
  });

  it("asks to check access before a shipped helper has actually connected", () => {
    const markup = render({
      status: status({
        health: {
          status: "unavailable",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).toContain("Computer access has not been checked");
    expect(markup).not.toContain("Computer control available");
    expect(markup).not.toContain("Capabilities");
    expect(markup).toContain("Set up");
  });

  it("reads out the split focus and raise abilities", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("keyboard focus");
    expect(markup).toContain("window raising");
  });

  it("drops screen capture from the abilities when the OS is withholding it", () => {
    // capture is a capability; captureAvailable is live health. Listing "screen
    // capture" on a blind desktop is the panel claiming something the machine
    // cannot do.
    const markup = render({
      status: status({
        health: {
          status: "connected",
          consecutiveFailures: 0,
          reconnects: 0,
          captureAvailable: false,
        },
      }),
    });
    expect(markup).not.toContain("screen capture");
    expect(markup).toContain("Screen capture is not allowed yet");
  });

  it("names the withheld grants and offers Set up", () => {
    const markup = render({
      status: status({
        availability: {
          kind: "permission-required",
          missing: ["accessibility", "screenRecording"],
          message: "macOS is asking for Accessibility.",
          buildSignature: "adhoc",
        },
      }),
    });
    expect(markup).toContain("Set up");
    expect(markup).toContain("not allowed yet");
    expect(markup).toContain("Accessibility");
  });

  it("hides the pane auto-open switch on a backend that drives the visible desktop", () => {
    // The server never requests a pane there, so the switch controls nothing —
    // and a switch that cannot change anything reads as a broken feature.
    expect(render({ status: status() })).not.toContain("Open automatically");
    expect(
      render({
        status: status({
          availability: { kind: "available", backend: "nested-kwin" },
          capabilities: capabilities({ visibleDesktop: false }),
        }),
      }),
    ).toContain("Open automatically");
  });

  it("exposes the default preference and explains automatic tool access", () => {
    const markup = render({ status: status() });
    expect(markup).toContain("Enable computer control by default");
    expect(markup).toContain("Agents can call computer tools when they need them");
    expect(markup).toContain("support images and tool calls");
  });
});
