// FILE: ComposerPendingApprovalPanel.browser.tsx
// Purpose: Browser regression coverage for the detached approval decision card.
// Layer: Chat composer UI browser test
// Depends on: ComposerPendingApprovalPanel and vitest-browser-react.

import {
  ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRequestKind,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { type PendingApproval } from "../../session-logic";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";

const APPROVAL_REQUEST_ID = ApprovalRequestId.makeUnsafe("approval-test-1");
const LIFECYCLE_GENERATION = "generation-test-1";

function makeApproval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    requestId: APPROVAL_REQUEST_ID,
    lifecycleGeneration: LIFECYCLE_GENERATION,
    requestKind: "command",
    createdAt: "2026-07-03T01:00:00.000Z",
    detail: 'Bash: {"command":"bun run test"}',
    ...overrides,
  };
}

async function mountApprovalPanel(input?: { approval?: PendingApproval; isResponding?: boolean }) {
  const onRespond = vi.fn(
    async (
      _requestId: ApprovalRequestId,
      _decision: ProviderApprovalDecision,
      _lifecycleGeneration?: string,
      _requestKind?: ProviderRequestKind,
    ) => undefined,
  );
  const screen = await render(
    <ComposerPendingApprovalPanel
      approval={input?.approval ?? makeApproval()}
      pendingCount={1}
      isResponding={input?.isResponding ?? false}
      onRespond={onRespond}
    />,
  );

  return {
    onRespond,
    cleanup: async () => {
      await screen.unmount();
    },
  };
}

describe("ComposerPendingApprovalPanel", () => {
  it.each([
    ["Approve once", "accept"],
    ["Always allow this session", "acceptForSession"],
    ["Decline", "decline"],
    ["Cancel turn", "cancel"],
  ] as const)("sends %s as an approval decision", async (label, decision) => {
    const mounted = await mountApprovalPanel();

    try {
      await page.getByRole("button", { name: new RegExp(label, "u") }).click();

      expect(mounted.onRespond).toHaveBeenCalledTimes(1);
      expect(mounted.onRespond).toHaveBeenCalledWith(
        APPROVAL_REQUEST_ID,
        decision,
        LIFECYCLE_GENERATION,
        "command",
      );
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders the request kind prompt and parsed command detail", async () => {
    const requestKind: ProviderRequestKind = "command";
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ requestKind }),
    });

    try {
      await expect.element(page.getByText("Approve this command?")).toBeInTheDocument();
      await expect.element(page.getByText("bun run test")).toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides session approval when the provider cannot persist it", async () => {
    const mounted = await mountApprovalPanel({
      approval: makeApproval({ sessionApprovalAvailable: false }),
    });

    try {
      await expect.element(page.getByRole("button", { name: /Approve once/u })).toBeInTheDocument();
      await expect
        .element(page.getByRole("button", { name: /Always allow this session/u }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.cleanup();
    }
  });
});
