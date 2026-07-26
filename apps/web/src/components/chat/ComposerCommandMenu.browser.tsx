import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerCommandMenu } from "./ComposerCommandMenu";

async function mountMenu(input: {
  isLoading: boolean;
  triggerKind: "mention" | "skill" | "slash-command" | null;
  emptyStateText?: string;
}) {
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <ComposerCommandMenu
      items={[]}
      resolvedTheme="dark"
      isLoading={input.isLoading}
      triggerKind={input.triggerKind}
      emptyStateText={input.emptyStateText}
      activeItemId={null}
      onHighlightedItemChange={vi.fn()}
      onSelect={vi.fn()}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("ComposerCommandMenu empty states", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it.each([
    ["mention", "mention", "Searching mentions..."],
    ["skill", "skill", "Loading skills..."],
    ["slash command", "slash-command", "Loading commands..."],
  ] as const)(
    "shows the %s loading label before results are available",
    async (_label, triggerKind, text) => {
      const menu = await mountMenu({ isLoading: true, triggerKind });

      try {
        await expect.element(page.getByText(text, { exact: true })).toBeVisible();
        if (triggerKind === "mention") {
          await expect.element(page.getByText("Files", { exact: true })).toBeVisible();
        } else {
          expect(document.querySelector('[data-slot="command-list"]')).toBeNull();
        }
      } finally {
        await menu.cleanup();
      }
    },
  );

  it("uses the supplied empty copy after loading completes", async () => {
    const menu = await mountMenu({
      isLoading: false,
      triggerKind: "slash-command",
      emptyStateText: "No commands are available for this provider.",
    });

    try {
      await expect
        .element(page.getByText("No commands are available for this provider.", { exact: true }))
        .toBeVisible();
      expect(document.body.textContent).not.toContain("Loading commands...");
    } finally {
      await menu.cleanup();
    }
  });
});
