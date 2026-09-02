// FILE: ComposerBranchMismatchBanner.test.tsx
// Purpose: Locks the branch-switch warning to its detached Codex-style notice surface.
// Layer: Chat composer UI regression test

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ComposerBranchMismatchBanner } from "./ComposerBranchMismatchBanner";
import { COMPOSER_INPUT_SURFACE_CLASS_NAME } from "./composerPickerStyles";

describe("ComposerBranchMismatchBanner", () => {
  it("renders branch movement in a compact floating notification card", () => {
    const markup = renderToStaticMarkup(
      <ComposerBranchMismatchBanner
        threadBranch="feature/finished"
        currentBranch="feature/current"
      />,
    );

    expect(markup).toContain('data-testid="composer-branch-mismatch-warning"');
    expect(markup).toContain("Sending a message will move this thread to the current branch");
    expect(markup).toContain("feature/finished");
    expect(markup).toContain("feature/current");
    for (const className of COMPOSER_INPUT_SURFACE_CLASS_NAME.split(/\s+/)) {
      expect(markup).toContain(className);
    }
    expect(markup).toContain("w-full");
    expect(markup).not.toContain("chat-composer-surface-banner");
  });
});
