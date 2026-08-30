// FILE: ThreadPrStatusBadge.browser.tsx
// Purpose: Guards the always-visible compact PR number and its clickable destination.
// Layer: Pull request presentation test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadPrStatusBadge } from "./ThreadPrStatusBadge";

describe("ThreadPrStatusBadge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("keeps the PR number visible without spending space on the hash prefix", async () => {
    const onOpen = vi.fn();
    await render(
      <ThreadPrStatusBadge
        pr={{
          number: 841,
          title: "Fix created-at thread ordering",
          url: "https://github.com/acme/synara/pull/841",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
        }}
        onOpen={onOpen}
      />,
    );

    const number = page.getByText("841", { exact: true });
    const button = page.getByRole("button", {
      name: "#841 PR open: Fix created-at thread ordering",
    });
    await expect.element(number).toBeVisible();

    const numberElement = document.querySelector<HTMLElement>("[data-pr-number='841']");
    const buttonElement = document.querySelector<HTMLButtonElement>("button");
    if (!numberElement || !buttonElement) {
      throw new Error("Expected the compact PR badge to render its number and button");
    }
    expect(getComputedStyle(numberElement).fontSize).toBe("8px");
    expect(Math.round(buttonElement.getBoundingClientRect().width)).toBe(24);

    await button.click();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]?.[1]).toBe("https://github.com/acme/synara/pull/841");
  });
});
