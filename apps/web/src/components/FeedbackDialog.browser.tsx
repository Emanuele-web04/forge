// FILE: FeedbackDialog.browser.tsx
// Purpose: Covers FeedbackDialogForm busy-state disabling with a real renderer.
//          The node-side test file uses renderToStaticMarkup, where the textarea
//          onChange never fires — so `details` stays empty and `canSubmit` /
//          `canDraft` are always false, which would let the busy flags regress
//          silently. Here we type a real report first so only the busy flag can
//          be what disables the buttons.

import "../index.css";

import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { FeedbackDialogForm } from "./FeedbackDialog";

const noopSubmit = async () => {};
const noopDraft = async () => {};

// The busy labels rename the buttons ("Sending…", "Opening thread…"), so the
// locators match a name pattern covering both the idle and busy labels.
const submitButton = () => page.getByRole("button", { name: /Submit|Sending/ });
const draftButton = () => page.getByRole("button", { name: /Draft a GitHub issue|Opening thread/ });

describe("FeedbackDialogForm busy state", () => {
  it.each([
    { isSending: true, isDraftingIssue: false },
    { isSending: false, isDraftingIssue: true },
  ])(
    "disables submit and draft buttons while isSending=$isSending isDraftingIssue=$isDraftingIssue",
    async ({ isSending, isDraftingIssue }) => {
      const view = await render(
        <FeedbackDialogForm
          initialCategory="bug"
          isSending={false}
          onSubmit={noopSubmit}
          onDraftGithubIssue={noopDraft}
        />,
      );

      // A non-empty report makes both actions available; only the busy flag can
      // disable them below.
      await page.getByLabelText("Feedback details").fill("the sidebar badge crashed");
      await expect.element(submitButton()).toBeEnabled();
      await expect.element(draftButton()).toBeEnabled();

      await view.rerender(
        <FeedbackDialogForm
          initialCategory="bug"
          isSending={isSending}
          isDraftingIssue={isDraftingIssue}
          onSubmit={noopSubmit}
          onDraftGithubIssue={noopDraft}
        />,
      );

      await expect.element(submitButton()).toBeDisabled();
      await expect.element(draftButton()).toBeDisabled();
    },
  );

  it("keeps the buttons enabled with a report and no busy flag", async () => {
    await render(
      <FeedbackDialogForm
        initialCategory="bug"
        isSending={false}
        onSubmit={noopSubmit}
        onDraftGithubIssue={noopDraft}
      />,
    );

    await page.getByLabelText("Feedback details").fill("the sidebar badge crashed");
    await expect.element(submitButton()).toBeEnabled();
    await expect.element(draftButton()).toBeEnabled();
  });
});
