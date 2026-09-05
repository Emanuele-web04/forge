import { expect, test } from "@playwright/test";
import { assertNoOverflow, preparePage, prepareRoute, VIEWPORTS } from "../test-helpers";

test.describe("homepage functional flow", () => {
  test("keeps one clear hero, aligned CTAs, and a prominent product screenshot", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await preparePage(page, "light");

    await expect(page.locator("h1")).toHaveText("Run every coding agent in one workspace");
    await expect(page.getByText("09 supported", { exact: true })).toHaveCount(0);

    const actions = page.locator("[data-home-actions]");
    const download = actions.getByRole("link", {
      name: /Download for|Download Synara/,
    });
    const github = actions.getByRole("link", { name: "Star on GitHub" });

    await expect(download).toHaveAttribute("href", "/install");
    await expect(github).toHaveAttribute("href", /github\.com/);

    const [downloadBox, githubBox] = await Promise.all([
      download.boundingBox(),
      github.boundingBox(),
    ]);
    expect(downloadBox).not.toBeNull();
    expect(githubBox).not.toBeNull();
    // Both CTAs share the same row in the compact hero.
    expect(Math.abs(downloadBox!.y - githubBox!.y)).toBeLessThanOrEqual(2);

    const preview = page.locator("[data-hero-preview]");
    await expect(preview).toBeVisible();
    const previewBox = await preview.boundingBox();
    expect(previewBox).not.toBeNull();
    expect(previewBox!.width).toBeGreaterThan(1100);
    expect(previewBox!.y).toBeLessThan(720);
  });

  test("keeps the quiet section rail out of narrower layouts", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await preparePage(page, "light");
    const rail = page.getByRole("navigation", { name: "Homepage sections" });
    await expect(rail).toBeVisible();
    await expect(rail.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "location",
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(rail).toBeHidden();
  });

  test("supports mobile navigation, FAQ disclosure, theme, and reduced motion", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await preparePage(page, "light");
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("button", { name: "Close navigation" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

    const faq = page.getByRole("button", { name: /What is Synara/ }).first();
    await faq.press("Enter");
    await expect(faq).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[role="region"]').first()).toBeVisible();

    await page.getByRole("button", { name: "Switch to dark mode" }).click();
    await expect(page.locator("html")).toHaveClass(/dark/);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(
      true,
    );
    await assertNoOverflow(page);
  });

  for (const [width, height] of VIEWPORTS) {
    test(`keeps landmarks and images stable at ${width}×${height}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await preparePage(page, width < 500 ? "dark" : "light");
      await expect(page.getByRole("main")).toHaveCount(1);
      await assertNoOverflow(page);
      expect(
        await page.evaluate(() =>
          [...document.images].every(
            (image) =>
              image.complete && image.naturalWidth > 0 && image.width > 0 && image.height > 0,
          ),
        ),
      ).toBe(true);
    });
  }

  test("keeps the desktop documentation TOC in its right rail", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1100 });
    await prepareRoute(page, "/docs", "light");

    const article = page.locator("#nd-page");
    const toc = page.locator("#nd-toc");
    await expect(article).toHaveAttribute("role", "main");
    await expect(toc).toBeVisible();

    const [articleBox, tocBox] = await Promise.all([article.boundingBox(), toc.boundingBox()]);
    expect(articleBox).not.toBeNull();
    expect(tocBox).not.toBeNull();
    expect(tocBox!.x).toBeGreaterThanOrEqual(articleBox!.x + articleBox!.width - 1);
    expect(tocBox!.y).toBeLessThan(100);

    const visibleLogo = page.locator("#nd-sidebar img").first();
    await expect(visibleLogo).toBeVisible();
    expect(
      await visibleLogo.evaluate((element) => {
        const image = element as HTMLImageElement;
        return image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
      }),
    ).toBe(true);
  });

  test("starts the production route and reaches the install and docs pages", async ({ page }) => {
    await preparePage(page, "light");
    await page.goto("/install", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.locator("h1")).toHaveText("Download Synara");
    await page.goto("/docs", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveCount(1);
  });
});
