// FILE: PullRequestStackPopover.browser.tsx
// Purpose: Browser coverage for the detail-header stack navigator and shared position indicator.
// Layer: Pull request presentation test

import "../../index.css";

import type { PullRequestStack, PullRequestStackEntry } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PullRequestStackPopover } from "./PullRequestStackPopover";

function entry(position: number): PullRequestStackEntry {
  return {
    position,
    number: 40 + position,
    title: `Layer ${position}`,
    url: `https://github.com/acme/app/pull/${40 + position}`,
    headBranch: `layer-${position}`,
    baseBranch: position === 1 ? "main" : `layer-${position - 1}`,
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    mergeStateStatus: "CLEAN",
  };
}

const stack: PullRequestStack = {
  number: 8,
  size: 3,
  position: 2,
  baseBranch: "main",
  entries: [entry(1), entry(2), entry(3)],
};

describe("PullRequestStackPopover", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("opens the full top-down stack and navigates to another pull request", async () => {
    const onSelectPullRequest = vi.fn();
    await render(
      <PullRequestStackPopover
        stack={stack}
        currentNumber={42}
        onSelectPullRequest={onSelectPullRequest}
      />,
    );

    await page.getByRole("button", { name: "View stack 8, pull request 2 of 3" }).click();

    expect(page.getByText("Ready to merge")).toBeVisible();
    expect(page.getByText("Stack #8 · targets main")).toBeVisible();
    await page.getByRole("button", { name: /Layer 3/ }).click();
    expect(onSelectPullRequest).toHaveBeenCalledWith(43);
  });
});
