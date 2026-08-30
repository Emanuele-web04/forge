// FILE: FeedbackDialog.test.tsx
// Purpose: Verifies the feedback dialog form preselects the Bug chip, renders
//          the GitHub issue draft action conditionally, and disables both
//          actions while sending.
// Layer: Web UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackDialogForm } from "./FeedbackDialog";

describe("FeedbackDialogForm", () => {
  it("preselects the Bug chip when initialCategory is bug", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm
        initialCategory="bug"
        isSending={false}
        onSubmit={() => Promise.resolve()}
      />,
    );

    expect(markup).toContain('aria-pressed="true"');
    // The selected chip is rendered before the unselected ones; count confirms
    // only one is selected across the six categories.
    const pressedMatches = markup.match(/aria-pressed="true"/g);
    expect(pressedMatches?.length).toBe(1);
  });

  it("shows the GitHub issue draft action only when onDraftGithubIssue is provided", () => {
    const withDraft = renderToStaticMarkup(
      <FeedbackDialogForm
        isSending={false}
        onSubmit={() => Promise.resolve()}
        onDraftGithubIssue={() => Promise.resolve()}
      />,
    );

    expect(withDraft).toContain("Draft a GitHub issue with your agent");

    const withoutDraft = renderToStaticMarkup(
      <FeedbackDialogForm isSending={false} onSubmit={() => Promise.resolve()} />,
    );

    expect(withoutDraft).not.toContain("Draft a GitHub issue with your agent");
  });

  it("disables both submit and draft actions while sending", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm
        defaultDetails="Something is broken"
        isSending
        isDraftingIssue={false}
        onSubmit={() => Promise.resolve()}
        onDraftGithubIssue={() => Promise.resolve()}
      />,
    );

    const buttons = markup.match(/<button\b[^>]*>/g) ?? [];
    const disabledButtons = buttons.filter((button) => button.includes("disabled"));

    // Submit and draft buttons should both be disabled while sending.
    expect(disabledButtons.length).toBeGreaterThanOrEqual(2);
  });
});
