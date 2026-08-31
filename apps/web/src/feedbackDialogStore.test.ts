// FILE: feedbackDialogStore.test.ts

import { describe, expect, it, vi } from "vitest";

describe("feedbackDialogStore", () => {
  it("opens with an optional category and context", async () => {
    vi.resetModules();
    const { useFeedbackDialogStore } = await import("./feedbackDialogStore");
    const context = { provider: "codex" as const } as Parameters<
      ReturnType<typeof useFeedbackDialogStore.getState>["openDialog"]
    >[0];

    useFeedbackDialogStore.getState().openDialog(context, "bug");

    expect(useFeedbackDialogStore.getState().isOpen).toBe(true);
    expect(useFeedbackDialogStore.getState().context).toBe(context);
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
