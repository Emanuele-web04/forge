// FILE: feedbackDialogStore.test.ts
// Purpose: Verifies the global feedback dialog store supports an optional
//          preselected category and clears it on close.
// Layer: Web UI state tests

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("feedbackDialogStore", () => {
  it("opens with a requested category and context", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");
    const context = { provider: "codex" as const } as Parameters<
      ReturnType<typeof useFeedbackDialogStore.getState>["openDialog"]
    >[0];

    useFeedbackDialogStore.getState().openDialog(context, "bug");

    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
    expect(useFeedbackDialogStore.getState().context).toBe(context);
    expect(useFeedbackDialogStore.getState().initialCategory).toBe("bug");
  });

  it("opens with no category when none is provided", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");

    useFeedbackDialogStore.getState().openDialog();

    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
    expect(useFeedbackDialogStore.getState().context).toBeNull();
    expect(useFeedbackDialogStore.getState().initialCategory).toBeNull();
  });

  it("clears category and context when the dialog is closed", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");

    useFeedbackDialogStore.getState().openDialog(undefined, "bug");
    expect(useFeedbackDialogStore.getState().initialCategory).toBe("bug");

    useFeedbackDialogStore.getState().setOpen(false);

    expect(useFeedbackDialogStore.getState().isOpen).toBe(false);
    expect(useFeedbackDialogStore.getState().context).toBeNull();
    expect(useFeedbackDialogStore.getState().initialCategory).toBeNull();
  });
});
