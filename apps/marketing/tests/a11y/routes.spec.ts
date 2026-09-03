import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { prepareRoute } from "../test-helpers";

for (const pathname of ["/", "/install", "/docs"]) {
  for (const theme of ["light", "dark"] as const) {
    test(`${pathname} ${theme} has no axe violations`, async ({ page }) => {
      await prepareRoute(page, pathname, theme);
      let builder = new AxeBuilder({ page });
      if (pathname === "/") {
        // The hero description + installer-count line are rendered in the LIVE
        // site's exact colors (Kartik: hero must match production pixel-for-pixel;
        // see HERO-REVERT.md REVIEW-FIX WAVE item 2). Those design-mandated colors
        // measure 4.36:1 / 2.72:1 on the page background — under the 4.5:1 AA
        // threshold — so ONLY those two elements are excluded from the scan.
        builder = builder.exclude('[data-live-hero-color="true"]');
      }
      const results = await builder.analyze();
      expect(results.violations).toEqual([]);
    });
  }
}
