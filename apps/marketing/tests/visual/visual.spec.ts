import { expect, test } from "@playwright/test";
import { preparePage, prepareRoute } from "../test-helpers";

const INSTALL_ANTIALIASING_TOLERANCE_PIXELS = 50;

const STABLE_DOCS_TOC = `
  #nd-toc a[data-active] {
    color: var(--color-fd-muted-foreground) !important;
  }

  #nd-toc [style*="--track-top"] {
    --track-top: 0px !important;
    --track-bottom: 0px !important;
  }

  .docs-meta > * {
    visibility: hidden !important;
  }
`;

test.describe("visual regression @visual", () => {
  test("homepage-desktop-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "light");
    await expect(page).toHaveScreenshot("homepage-desktop-light.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-desktop-dark", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "dark");
    await expect(page).toHaveScreenshot("homepage-desktop-dark.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-mobile-light", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "light");
    await expect(page).toHaveScreenshot("homepage-mobile-light.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-mobile-dark", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "dark");
    await expect(page).toHaveScreenshot("homepage-mobile-dark.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-hero-desktop-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "light");
    await expect(page.locator(".hero-section")).toHaveScreenshot(
      "homepage-hero-desktop-light.png",
      { animations: "disabled", maxDiffPixels: 0 },
    );
  });

  test("homepage-hero-mobile-dark", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "dark");
    await expect(page.locator(".hero-section")).toHaveScreenshot("homepage-hero-mobile-dark.png", {
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-workflows-desktop-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "light");
    const workflow = page
      .locator("section")
      .filter({ hasText: "From objective to evidence" })
      .first();
    await expect(workflow).toHaveScreenshot("homepage-workflows-desktop-light.png", {
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("homepage-trust-mobile-light", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "light");
    const trust = page
      .locator("section")
      .filter({ hasText: "Know where every part of the work goes" })
      .first();
    await expect(trust).toHaveScreenshot("homepage-trust-mobile-light.png", {
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("install-desktop-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/install", "light");
    await expect(page).toHaveScreenshot("install-desktop-light.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: INSTALL_ANTIALIASING_TOLERANCE_PIXELS,
    });
  });

  test("docs-desktop-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/docs", "light");
    await page.addStyleTag({ content: STABLE_DOCS_TOC });
    await expect(page).toHaveScreenshot("docs-desktop-light.png", {
      fullPage: true,
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });

  test("docs-media-core-concepts-light", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/docs/getting-started/core-concepts", "light");
    const media = page.locator('[data-docs-media="image"]').first();
    await expect(media).toHaveScreenshot("docs-media-core-concepts-light.png", {
      animations: "disabled",
      maxDiffPixels: 0,
    });
  });
});
