// FILE: computerProvisioning.ts
// Purpose: One vocabulary for "set up computer control" — the toasts the chat card
//          raises, the inline note the settings panel renders, and the rule for what
//          counts as done. Pure so both surfaces can be pinned by tests.
// Layer: Web UI logic
// Exports: computerProvisionOutcome, computerProvisionStartToast, computerProvisionResultToast,
//          computerProvisionNote
//
// The card and the panel used to each own a private copy of this flow, and they
// said different things about the same server call: one raised a toast the other
// did not, one had no pending state, and the two could fire the underlying
// provision concurrently. The state machine lives in `useProvisionComputer`; the
// words live here.

import type { ComputerPermission, ComputerProvisionResult } from "@synara/contracts";
import { listComputerPermissions } from "@synara/shared/computerPermissions";

import { computerStatusNeedsSetup } from "~/components/ComputerPanel.logic";

/** What the server's answer means for the user, once. */
export type ComputerProvisionOutcome = "ready" | "incomplete";

export function computerProvisionOutcome(
  result: ComputerProvisionResult,
): ComputerProvisionOutcome {
  return computerStatusNeedsSetup(result.status) ? "incomplete" : "ready";
}

export interface ComputerProvisionToast {
  readonly type: "info" | "success" | "warning" | "error";
  readonly title: string;
  readonly description: string;
}

/**
 * Raised as the call starts, because the call's visible effect is a macOS
 * dialog appearing over Synara and the user needs to know Synara asked for it.
 *
 * The grants are named through `listComputerPermissions` rather than written
 * out, so this cannot drift out of the one fixed ordering every other surface
 * uses — a hand-written "Screen Recording and Accessibility" here against
 * "Accessibility and Screen Recording" in the card is exactly the divergence
 * that module exists to prevent.
 */
export function computerProvisionStartToast(
  missing: readonly ComputerPermission[] = [],
): ComputerProvisionToast {
  const labels = listComputerPermissions(missing);
  return {
    type: "info",
    title: "Setting up computer control",
    description:
      labels.length > 0
        ? `macOS may ask to allow ${labels} for Synara.`
        : "macOS may ask to allow the permissions Synara needs for this.",
  };
}

/** The one answer, whichever surface asked. */
export function computerProvisionResultToast(
  result: ComputerProvisionResult,
): ComputerProvisionToast {
  return computerProvisionOutcome(result) === "ready"
    ? { type: "success", title: "Computer control is ready", description: result.summary }
    : {
        type: "warning",
        title: "Computer control still needs a permission",
        description: result.summary,
      };
}

export function computerProvisionErrorToast(error: unknown): ComputerProvisionToast {
  return {
    type: "error",
    title: "Couldn't set up computer control",
    description: provisionErrorMessage(error),
  };
}

export function provisionErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "The server gave no reason.";
}

/**
 * The settings panel's inline status line — the same three states the toasts
 * describe, for a surface that has room to keep them on screen.
 */
export function computerProvisionNote(state: {
  readonly isPending: boolean;
  readonly error?: unknown;
  readonly result?: ComputerProvisionResult | undefined;
}): string | undefined {
  if (state.isPending) {
    return (
      "Setting up the agent's desktop. This installs or builds whatever this machine still needs, " +
      "and may ask for your password or for desktop permissions. The first run can take a few minutes."
    );
  }
  if (state.error !== undefined && state.error !== null) {
    return `Setting up failed. ${provisionErrorMessage(state.error)}`;
  }
  return state.result?.summary;
}
