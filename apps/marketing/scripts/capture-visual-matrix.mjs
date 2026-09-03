import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const baseUrl = process.env.VISUAL_BASE_URL ?? "http://127.0.0.1:3001";
const outputDir = path.resolve(
  process.env.VISUAL_OUTPUT_DIR ?? "tests/visual/evidence/phase0-baseline",
);

const matrix = [
  ["large-desktop", 1440, 1100],
  ["laptop", 1280, 900],
  ["tablet-landscape", 1024, 768],
  ["tablet-boundary", 768, 1024],
  ["mobile", 390, 844],
  ["narrow-mobile", 360, 800],
];

async function waitForImages(page) {
  await page.evaluate(async () => {
    const images = [...document.images];
    for (const image of images) {
      image.scrollIntoView({ block: "center", inline: "nearest" });
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    window.scrollTo(0, 0);
  });

  await page.waitForFunction(
    () => [...document.images].every((image) => image.complete),
    undefined,
    { timeout: 30_000 },
  );

  const incomplete = await page.evaluate(() =>
    [...document.images]
      .map((image, index) => ({
        index,
        src: image.currentSrc || image.src,
        alt: image.alt,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
      }))
      .filter((image) => !image.complete || image.naturalWidth === 0),
  );

  if (incomplete.length > 0) {
    throw new Error(
      `Visual capture found incomplete images:\n${JSON.stringify(incomplete, null, 2)}`,
    );
  }

  return await page.evaluate(() => document.images.length);
}

async function capture() {
  await mkdir(outputDir, { recursive: true });
  const browser = await chromium.launch();
  const results = [];

  try {
    for (const theme of ["light", "dark"]) {
      for (const [name, width, height] of matrix) {
        console.log(`Capturing ${theme}/${name} at ${width}x${height}`);
        const context = await browser.newContext({
          viewport: { width, height },
          reducedMotion: "reduce",
        });
        const page = await context.newPage();
        await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
        await page.evaluate((selectedTheme) => {
          document.documentElement.classList.toggle("dark", selectedTheme === "dark");
          localStorage.setItem("synara-theme", selectedTheme);
        }, theme);
        await page.reload({ waitUntil: "domcontentloaded" });
        const imageCount = await waitForImages(page);
        const metrics = await page.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
          focusables: document.querySelectorAll(
            'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])',
          ).length,
          overflow: document.documentElement.scrollWidth > window.innerWidth,
          incompleteImages: [...document.images].filter(
            (image) => !image.complete || image.naturalWidth === 0,
          ).length,
        }));
        if (metrics.incompleteImages !== 0) {
          throw new Error(`Incomplete image assertion failed for ${theme}/${name}`);
        }
        await page.screenshot({
          path: path.join(outputDir, `${theme}-${name}.jpg`),
          fullPage: true,
          type: "jpeg",
          quality: 60,
          animations: "disabled",
        });
        results.push({
          theme,
          name,
          viewport: [width, height],
          imageCount,
          ...metrics,
        });
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }

  await writeFile(path.join(outputDir, "audit.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
}

capture().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
