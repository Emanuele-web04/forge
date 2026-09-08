// FILE: computerProvisioning.test.ts
// Purpose: Pin the one "set up computer control" vocabulary the chat card and the
//          settings panel now share.
// Layer: Web UI logic tests

import type { ComputerProvisionResult, ComputerStatusResult } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  computerProvisionErrorToast,
  computerProvisionNote,
  computerProvisionOutcome,
  computerProvisionResultToast,
  computerProvisionStartToast,
} from "./computerProvisioning";

const READY_STATUS: ComputerStatusResult = {
  computerId: "computer-1",
  availability: { kind: "available", backend: "mac" },
  health: {
    status: "connected",
    captureAvailable: true,
    consecutiveFailures: 0,
    reconnects: 0,
  },
  capabilities: {
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
  },
} as unknown as ComputerStatusResult;

function result(
  overrides: Partial<ComputerStatusResult>,
  summary: string,
): ComputerProvisionResult {
  return { summary, status: { ...READY_STATUS, ...overrides } };
}

describe("computerProvisionOutcome", () => {
  it("is ready only when the refreshed status leaves nothing to set up", () => {
    expect(computerProvisionOutcome(result({}, "Started the helper."))).toBe("ready");
    expect(
      computerProvisionOutcome(
        result(
          {
            availability: {
              kind: "permission-required",
              missing: ["accessibility"],
              message: "needs Accessibility",
              buildSignature: "adhoc",
            },
          },
          "Asked macOS.",
        ),
      ),
    ).toBe("incomplete");
  });
});

describe("computer provision toasts", () => {
  it("names the outstanding grants through the shared ordering", () => {
    // Not hand-written: a second spelling of "Screen Recording and
    // Accessibility" here against the card's ordering is exactly the drift
    // `listComputerPermissions` exists to prevent.
    const toast = computerProvisionStartToast(["screenRecording", "accessibility"]);
    expect(toast.description).toContain("Accessibility and Screen Recording");
    expect(toast.type).toBe("info");
  });

  it("falls back to general wording when no grant has been named", () => {
    expect(computerProvisionStartToast().description).not.toContain("Accessibility");
    expect(computerProvisionStartToast([]).description).toContain("permissions Synara needs");
  });

  it("distinguishes a finished setup from one still missing a grant", () => {
    expect(computerProvisionResultToast(result({}, "All set.")).type).toBe("success");
    const incomplete = computerProvisionResultToast(
      result(
        {
          availability: {
            kind: "permission-required",
            missing: ["accessibility"],
            message: "needs Accessibility",
            buildSignature: "adhoc",
          },
        },
        "Asked macOS.",
      ),
    );
    expect(incomplete.type).toBe("warning");
    // The server's own sentence, not a second account of it.
    expect(incomplete.description).toBe("Asked macOS.");
  });

  it("reports a failure without inventing a reason", () => {
    expect(computerProvisionErrorToast(new Error("build failed")).description).toBe("build failed");
    expect(computerProvisionErrorToast(undefined).description).toBe("The server gave no reason.");
  });
});

describe("computerProvisionNote", () => {
  it("says the same three things the toasts do, for a surface with room", () => {
    expect(computerProvisionNote({ isPending: true })).toContain("Setting up");
    expect(computerProvisionNote({ isPending: false, error: new Error("nope") })).toBe(
      "Setting up failed. nope",
    );
    expect(
      computerProvisionNote({ isPending: false, result: result({}, "Started the helper.") }),
    ).toBe("Started the helper.");
    expect(computerProvisionNote({ isPending: false })).toBeUndefined();
  });

  it("lets the in-flight message outrank a previous attempt's outcome", () => {
    expect(computerProvisionNote({ isPending: true, error: new Error("nope") })).toContain(
      "Setting up the agent's desktop",
    );
  });
});
