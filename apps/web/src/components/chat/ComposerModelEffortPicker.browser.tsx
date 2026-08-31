import "../../index.css";

import { type ModelSlug, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerModelEffortPicker } from "./ComposerModelEffortPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-grok-model-effort-picker");
const GROK_4_6 = "grok-4.6" as ModelSlug;

describe("ComposerModelEffortPicker", () => {
  it("keeps Grok 4.6 effort visible in compact layouts before runtime discovery", async () => {
    const screen = await render(
      <ComposerModelEffortPicker
        provider="grok"
        model={GROK_4_6}
        lockedProvider={null}
        modelOptionsByProvider={{
          claudeAgent: [],
          codex: [],
          cursor: [],
          antigravity: [],
          grok: [{ slug: GROK_4_6, name: "Grok 4.6" }],
          droid: [],
          opencode: [],
          pi: [],
        }}
        hideStatusLabel
        onProviderModelChange={vi.fn()}
        threadId={THREAD_ID}
        modelOptions={undefined}
        prompt=""
        onPromptChange={vi.fn()}
      />,
    );

    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      await expect.element(trigger).toHaveAttribute("title", "High");
      expect(trigger.element().querySelector('[data-slot="central-icon"]')).not.toBeNull();

      await trigger.click();
      await expect.element(page.getByRole("menuitemradio", { name: "Low" })).toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Medium" })).toBeVisible();
      await expect
        .element(page.getByRole("menuitemradio", { name: "High (default)" }))
        .toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Extra High" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
