import "../../index.css";

import { type ModelSlug, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerModelEffortPicker } from "./ComposerModelEffortPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-grok-model-effort-picker");
const GROK_4_5 = "grok-4.5" as ModelSlug;

describe("ComposerModelEffortPicker", () => {
  it("keeps Grok effort visible in compact layouts before runtime discovery", async () => {
    const screen = await render(
      <ComposerModelEffortPicker
        provider="grok"
        model={GROK_4_5}
        lockedProvider={null}
        modelOptionsByProvider={{
          claudeAgent: [],
          codex: [],
          cursor: [],
          antigravity: [],
          grok: [{ slug: GROK_4_5, name: "Grok 4.5" }],
          deepseek: [],
          droid: [],
          kilo: [],
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
      await expect.element(trigger).toHaveAttribute("title", "Low");
      expect(trigger.element().querySelector('[data-slot="central-icon"]')).not.toBeNull();

      await trigger.click();
      await expect.element(page.getByRole("menuitemradio", { name: "None" })).toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Low" })).toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "Medium" })).toBeVisible();
      await expect.element(page.getByRole("menuitemradio", { name: "High" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });
});
