import "../../index.css";

import { type ModelSlug, ThreadId } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { resetComposerDraftStore } from "../../composerDraftStoreTestFixtures";
import { ComposerModelEffortPicker } from "./ComposerModelEffortPicker";

const THREAD_ID = ThreadId.makeUnsafe("thread-grok-model-effort-picker");
const GROK_4_5 = "grok-4.5" as ModelSlug;
const CODEX_THREAD_ID = ThreadId.makeUnsafe("thread-codex-model-effort-picker");
const CODEX_GPT_5_2 = "gpt-5.2" as ModelSlug;

function renderGrokPicker() {
  return render(
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
}

function renderCodexPicker() {
  return render(
    <ComposerModelEffortPicker
      provider="codex"
      model={CODEX_GPT_5_2}
      lockedProvider={null}
      modelOptionsByProvider={{
        claudeAgent: [],
        codex: [{ slug: CODEX_GPT_5_2, name: "GPT-5.2" }],
        cursor: [],
        antigravity: [],
        grok: [],
        droid: [],
        kilo: [],
        opencode: [],
        pi: [],
      }}
      hideStatusLabel
      onProviderModelChange={vi.fn()}
      threadId={CODEX_THREAD_ID}
      modelOptions={{ reasoningEffort: "xhigh", fastMode: false }}
      prompt=""
      onPromptChange={vi.fn()}
    />,
  );
}

describe("ComposerModelEffortPicker", () => {
  beforeEach(() => {
    resetComposerDraftStore();
  });

  afterEach(() => {
    resetComposerDraftStore();
  });

  it("maps Grok's provider-specific effort ladder onto the universal slider", async () => {
    const screen = await renderGrokPicker();

    try {
      const trigger = page.getByRole("button", { name: "Change model and reasoning" });
      await expect.element(trigger).toHaveAttribute("title", "Low");
      expect(trigger.element().querySelector('[data-slot="central-icon"]')).not.toBeNull();

      await trigger.click();
      await expect.element(page.getByText("Advanced", { exact: true })).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Fast mode" })).not.toBeInTheDocument();
      const effortSlider = page.getByRole("slider", { name: "Effort" });
      await expect.element(effortSlider).toBeVisible();
      await expect.element(effortSlider).toHaveAttribute("min", "0");
      await expect.element(effortSlider).toHaveAttribute("max", "3");
      await expect.element(effortSlider).toHaveAttribute("step", "0.01");
      await expect.element(effortSlider).toHaveAttribute("aria-valuetext", "Low");
      expect(document.querySelector(".composer-effort-slider-electric-field")).toBeNull();
      expect(document.querySelector(".composer-effort-slider-thumb svg")).toBeNull();

      await effortSlider.fill("1.6");
      await expect
        .poll(() => {
          const selection =
            useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelSelectionByProvider
              .grok;
          return selection?.provider === "grok" ? selection.options?.reasoningEffort : undefined;
        })
        .toBe("medium");
      await expect.element(effortSlider).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("expands named controls inline and returns to the direct slider", async () => {
    const screen = await renderGrokPicker();

    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      const advancedToggle = page.getByRole("menuitem", { name: "Advanced" });
      await advancedToggle.click();

      await expect.element(page.getByRole("slider", { name: "Effort" })).not.toBeInTheDocument();
      await expect.element(page.getByText("Model", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Effort", { exact: true }).first()).toBeVisible();

      advancedToggle.element().dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect.element(page.getByRole("slider", { name: "Effort" })).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the Fast Mode quick toggle beside Advanced for supported models", async () => {
    const screen = await renderCodexPicker();

    try {
      await page.getByRole("button", { name: "Change model and reasoning" }).click();
      const fastModeToggle = page.getByRole("button", { name: "Fast mode" });
      await expect.element(fastModeToggle).toHaveAttribute("aria-pressed", "false");
      await expect.element(fastModeToggle).toHaveTextContent("Fast");

      const fastModeButton = fastModeToggle.element();
      const advancedLabel = page.getByText("Advanced", { exact: true }).element();
      const advancedRow = advancedLabel.closest<HTMLElement>('[role="menuitem"]');
      const fastModeIcon = fastModeButton.querySelector<HTMLElement>(
        '[data-slot="fast-mode-icon"]',
      );
      const fastModeLabel = fastModeButton.querySelector<HTMLElement>(
        '[data-slot="fast-mode-label"]',
      );
      expect(advancedRow).not.toBeNull();
      expect(fastModeIcon).not.toBeNull();
      expect(fastModeLabel).not.toBeNull();

      const centerY = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        return bounds.top + bounds.height / 2;
      };
      const buttonBounds = fastModeButton.getBoundingClientRect();
      const iconBounds = fastModeIcon!.getBoundingClientRect();
      const labelBounds = fastModeLabel!.getBoundingClientRect();
      const contentCenterX =
        (Math.min(iconBounds.left, labelBounds.left) +
          Math.max(iconBounds.right, labelBounds.right)) /
        2;
      expect(Math.abs(centerY(advancedRow!) - centerY(fastModeButton))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(centerY(advancedLabel) - centerY(fastModeButton))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(centerY(fastModeButton) - centerY(fastModeIcon!))).toBeLessThanOrEqual(0.5);
      expect(Math.abs(centerY(fastModeButton) - centerY(fastModeLabel!))).toBeLessThanOrEqual(0.5);
      expect(
        Math.abs(buttonBounds.left + buttonBounds.width / 2 - contentCenterX),
      ).toBeLessThanOrEqual(0.5);

      await fastModeToggle.click();
      await expect
        .poll(() => {
          const selection =
            useComposerDraftStore.getState().draftsByThreadId[CODEX_THREAD_ID]
              ?.modelSelectionByProvider.codex;
          return selection?.provider === "codex" ? selection.options?.fastMode : undefined;
        })
        .toBe(true);
      await expect.element(page.getByRole("slider", { name: "Effort" })).toBeVisible();

      advancedRow!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await expect.element(page.getByText("Model", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Effort", { exact: true }).first()).toBeVisible();
      await expect.element(page.getByText("Speed", { exact: true })).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
