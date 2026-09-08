// FILE: feedbackDialogStore.test.ts

import { describe, expect, it, vi } from "vitest";

import type { FeedbackThreadContext } from "./feedback";

const TEST_CONTEXT: FeedbackThreadContext = {
  provider: "codex",
  model: null,
  projectKind: null,
  environmentMode: null,
  runtimeMode: null,
  interactionMode: null,
  sessionStatus: null,
  latestTurnState: null,
  messageCount: 0,
  activityCount: 0,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasThreadError: false,
};

describe("feedbackDialogStore", () => {
  it("opens with an optional category and context", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");

    useFeedbackDialogStore.getState().openDialog(TEST_CONTEXT, "bug");

    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
    expect(useFeedbackDialogStore.getState().context).toBe(TEST_CONTEXT);
    expect(useFeedbackDialogStore.getState().initialCategory).toBe("bug");

    useFeedbackDialogStore.getState().setOpen(false);

    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
    expect(useFeedbackDialogStore.getState().context).toBeNull();
    expect(useFeedbackDialogStore.getState().initialCategory).toBeNull();
  });

  it("opens with no category when none is provided", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");

    useFeedbackDialogStore.getState().openDialog();

    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
    expect(useFeedbackDialogStore.getState().context).toBeNull();
    expect(useFeedbackDialogStore.getState().initialCategory).toBeNull();
  });
});
