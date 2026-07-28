// FILE: composerStackedPanelStyles.test.ts
// Purpose: Pins the shared composer-stacked panel row and chrome tokens.
// Layer: Chat composer regression test

import { describe, expect, it } from "vitest";

import {
  COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ICON_CLASS_NAME,
  COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME,
  COMPOSER_STACKED_PANEL_ROW_CLASS_NAME,
  COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME,
} from "./composerStackedPanelStyles";

describe("composerStackedPanelStyles", () => {
  it("keeps stacked panel chrome on the recessed stacked-top treatment", () => {
    expect(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME).toContain("chat-composer-stacked-top");
    expect(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME).not.toContain("chat-composer-surface");
    expect(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME).toContain("border-b-0");
    expect(COMPOSER_STACKED_PANEL_CHROME_CLASS_NAME).not.toContain("z-[1]");
  });

  it("keeps stacked panel rows on one shared compact padding and type scale", () => {
    expect(COMPOSER_STACKED_PANEL_ROW_CLASS_NAME).toContain("px-2.5");
    expect(COMPOSER_STACKED_PANEL_ROW_CLASS_NAME).toContain("py-1.5");
    expect(COMPOSER_STACKED_PANEL_ROW_CLASS_NAME).toContain("text-[12px]");
  });

  it("keeps unbounded row lists capped so large agent fleets cannot push the composer off-screen", () => {
    expect(COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME).toContain("max-h-");
    expect(COMPOSER_STACKED_PANEL_SCROLL_REGION_CLASS_NAME).toContain("overflow-y-auto");
  });

  it("keeps icon and label treatments aligned across stacked panels", () => {
    expect(COMPOSER_STACKED_PANEL_ICON_CLASS_NAME).toContain("size-3.5");
    expect(COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME).toContain("font-medium");
    expect(COMPOSER_STACKED_PANEL_LABEL_CLASS_NAME).toContain("text-foreground/85");
  });
});
