// FILE: FeedbackDialog.test.tsx

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FeedbackDialogForm } from "./FeedbackDialog";

const noopSubmit = async () => {};
const noopDraft = async () => {};

const actionButtons = (markup: string): string[] =>
  (markup.match(/<button\b[\s\S]*?<\/button>/g) ?? []).filter(
    (button) =>
      button.includes('type="submit"') ||
      button.includes(">Submit") ||
      button.includes(">Sending…") ||
      button.includes(">Draft a GitHub issue") ||
      button.includes(">Opening thread"),
  );

describe("FeedbackDialogForm", () => {
  it("preselects the Bug chip when initialCategory is bug", () => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm initialCategory="bug" isSending={false} onSubmit={noopSubmit} />,
    );

    expect(markup).toContain('aria-pressed="true"');
    expect(markup.match(/aria-pressed="true"/g)?.length).toBe(1);
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

  it.each([
    { isSending: true, label: "Sending…" },
    { isDraftingIssue: true, label: "Opening thread" },
  ])("disables submit and draft buttons while $label", ({ isSending, isDraftingIssue }) => {
    const markup = renderToStaticMarkup(
      <FeedbackDialogForm
        initialCategory="bug"
        isSending={isSending ?? false}
        isDraftingIssue={isDraftingIssue ?? false}
        onSubmit={noopSubmit}
        onDraftGithubIssue={noopDraft}
      />,
    );

    const buttons = actionButtons(markup);
    expect(buttons.length).toBe(2);
    expect(buttons.every((button) => button.includes("disabled"))).toBe(true);
  });
});
