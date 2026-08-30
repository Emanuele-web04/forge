// FILE: FeedbackDialog.test.tsx
// Purpose: Verifies the feedback dialog form preselects the Bug chip, renders
//          the GitHub issue draft action conditionally, and disables both
//          actions while in flight.
// Layer: Web UI tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackDialogForm } from "./FeedbackDialog";

const noopSubmit = async () => {};
const noopDraft = async () => {};

function getActionButtons(markup: string): string[] {
  // Full button tag plus children so we can identify the two main actions.
  const buttons = markup.match(/<button\b[\s\S]*?<\/button>/g) ?? [];
  return buttons.filter(
    (button) =>
      button.includes('type="submit"') ||
      button.includes(">Submit") ||
      button.includes(">Sending…") ||
      button.includes(">Draft a GitHub issue") ||
      button.includes(">Opening thread"),
  );
}

describe("FeedbackDialogForm", () => {
  it("preselects the Bug chip when initialCategory is bug", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm initialCategory="bug" isSending={false} onSubmit={noopSubmit} />,
    );

    expect(markup).toContain('aria-pressed="true"');
    // The selected chip is rendered before the unselected ones; count confirms
    // only one is selected across the six categories.
    const pressedMatches = markup.match(/aria-pressed="true"/g);
    expect(pressedMatches?.length).toBe(1);
  });

  it("renders category chips inside an accessible group", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm isSending={false} onSubmit={noopSubmit} />,
    );

    expect(markup).toContain('role="group"');
    expect(markup).toContain('aria-label="Feedback category"');
  });

  it("shows the GitHub issue draft action only when category is bug and onDraftGithubIssue is provided", () => {
    const withBugAndDraft = renderToStaticMarkup(
      <FeedbackDialogForm
        initialCategory="bug"
        isSending={false}
        onSubmit={noopSubmit}
        onDraftGithubIssue={noopDraft}
      />,
    );
    expect(withBugAndDraft).toContain("Draft a GitHub issue with your agent");

    const withoutCategory = renderToStaticMarkup(
      <FeedbackDialogForm isSending={false} onSubmit={noopSubmit} onDraftGithubIssue={noopDraft} />,
    );
    expect(withoutCategory).not.toContain("Draft a GitHub issue with your agent");

    const withoutDraftProp = renderToStaticMarkup(
      <FeedbackDialogForm initialCategory="bug" isSending={false} onSubmit={noopSubmit} />,
    );
    expect(withoutDraftProp).not.toContain("Draft a GitHub issue with your agent");
  });

  it("disables submit and draft buttons while sending", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm
        initialCategory="bug"
        defaultDetails="Something is broken"
        isSending
        isDraftingIssue={false}
        onSubmit={noopSubmit}
        onDraftGithubIssue={noopDraft}
      />,
    );

    const actionButtons = getActionButtons(markup);
    expect(actionButtons.length).toBe(2);
    expect(actionButtons.every((button) => button.includes("disabled"))).toBe(true);
  });

  it("disables submit and draft buttons while drafting an issue", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm
        initialCategory="bug"
        defaultDetails="Something is broken"
        isSending={false}
        isDraftingIssue
        onSubmit={noopSubmit}
        onDraftGithubIssue={noopDraft}
      />,
    );

    const actionButtons = getActionButtons(markup);
    expect(actionButtons.length).toBe(2);
    expect(actionButtons.every((button) => button.includes("disabled"))).toBe(true);
  });
});
