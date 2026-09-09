import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { assertNoOverflow, prepareRoute } from "../test-helpers";

const CONTENT_ROOT = path.resolve(process.cwd(), "content/docs");

function walk(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = path.join(directory, entry);
    return statSync(fullPath).isDirectory() ? walk(fullPath) : [fullPath];
  });
}

function routeForFile(file: string) {
  const relative = path.relative(CONTENT_ROOT, file).replaceAll(path.sep, "/");
  const withoutExtension = relative.replace(/\.mdx$/, "");
  const slug =
    withoutExtension === "index"
      ? ""
      : withoutExtension.endsWith("/index")
        ? withoutExtension.slice(0, -"/index".length)
        : withoutExtension;
  return slug ? `/docs/${slug}` : "/docs";
}

const mediaRoutes = walk(CONTENT_ROOT)
  .filter((file) => file.endsWith(".mdx"))
  .filter((file) => /<Docs(?:Image|Screenshot|Gallery|Video)\b/.test(readFileSync(file, "utf8")))
  .map(routeForFile)
  .sort();

test.describe("documentation media", () => {
  test("has at least one production integration", () => {
    expect(mediaRoutes.length).toBeGreaterThan(0);
  });

  for (const route of mediaRoutes) {
    test(`${route} renders stable, accessible local media`, async ({ page }) => {
      await page.setViewportSize({ width: 1_440, height: 1_100 });
      await prepareRoute(page, route, "light");

      const media = page.locator("[data-docs-media]");
      await expect(media.first()).toBeVisible();
      await assertNoOverflow(page);

      for (const imageFigure of await page.locator('[data-docs-media="image"]').all()) {
        await expect(imageFigure).toHaveAttribute("data-provenance", /^(real|derived|diagram)$/);
        const visibleImages = imageFigure.locator("img:visible");
        await expect(visibleImages).toHaveCount(1);

        const dimensions = await visibleImages.evaluateAll((images) =>
          images.map((image) => ({
            src: image.getAttribute("src"),
            alt: image.getAttribute("alt"),
            width: image.getAttribute("width"),
            height: image.getAttribute("height"),
            naturalWidth: (image as HTMLImageElement).naturalWidth,
            naturalHeight: (image as HTMLImageElement).naturalHeight,
            complete: (image as HTMLImageElement).complete,
          })),
        );

        for (const image of dimensions) {
          expect(image.src).toBeTruthy();
          expect(image.src).not.toMatch(/^https?:\/\//);
          expect(image.alt?.trim().length).toBeGreaterThan(10);
          expect(Number(image.width)).toBeGreaterThan(0);
          expect(Number(image.height)).toBeGreaterThan(0);
          expect(image.naturalWidth).toBeGreaterThan(0);
          expect(image.naturalHeight).toBeGreaterThan(0);
          expect(image.complete).toBe(true);
        }

        const fullSizeLink = imageFigure.locator('a[target="_blank"]:visible');
        await expect(fullSizeLink).toHaveCount(1);
        await expect(fullSizeLink).toHaveAttribute("rel", /noopener/);
      }

      for (const videoFigure of await page.locator('[data-docs-media="video"]').all()) {
        const video = videoFigure.locator("video");
        await expect(video).toHaveAttribute("controls", "");
        await expect(video).toHaveAttribute("preload", "metadata");
        await expect(video).not.toHaveAttribute("autoplay", /.*/);
        await expect(video.locator('track[kind="captions"][default]')).toHaveCount(1);
        await expect(videoFigure.locator("details summary")).toHaveText("Video transcript");
      }

      for (const gallery of await page.locator('[data-docs-media="gallery"]').all()) {
        const label = await gallery.getAttribute("aria-label");
        expect(label?.trim().length).toBeGreaterThan(3);
        expect(await gallery.locator('[data-docs-media="image"]').count()).toBeGreaterThanOrEqual(
          2,
        );
      }

      const themeToggle = page.getByRole("button", { name: "Switch to dark mode" }).first();
      if (await themeToggle.isVisible()) {
        await themeToggle.click();
        await expect(page.locator("html")).toHaveClass(/dark/);
        for (const imageFigure of await page.locator('[data-docs-media="image"]').all()) {
          await expect(imageFigure.locator("img:visible")).toHaveCount(1);
        }
      }
    });
  }
});
