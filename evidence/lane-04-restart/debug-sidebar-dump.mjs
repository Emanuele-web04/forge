// Debug: dump sidebar structure (sections + project rows) as JSON outline.
import { createRequire } from "node:module";

const WEB_DIR = "/Users/user/synara-handoff-wt/plan-04/apps/web";
const require = createRequire(`${WEB_DIR}/package.json`);
const { chromium } = require("playwright");

const USER_DATA_DIR = "/Users/user/synara-handoff-wt/plan-04/.synara-h04/browser-profile-h04";

const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
page.setDefaultTimeout(120000);
try {
  await page.goto(process.env.WEB_URL ?? "http://localhost:8837/", {
    waitUntil: "commit",
    timeout: 180000,
  });
  await page.waitForSelector('[data-slot="sidebar"]', { timeout: 120000 });
  await page.waitForTimeout(4000);
  const outline = await page.evaluate(() => {
    const sidebar = document.querySelector('[data-slot="sidebar"]');
    if (!sidebar) return { error: "no sidebar" };
    const outline = [];
    const walk = (el, depth) => {
      if (outline.length > 400) return;
      const cls = typeof el.className === "string" ? el.className : "";
      const isProjectContainer = el.tagName === "DIV" && cls.includes("group/collapsible");
      const isMenuButton =
        el.tagName === "BUTTON" && el.getAttribute("data-sidebar") === "menu-button";
      const isSubButton =
        el.tagName === "BUTTON" && el.getAttribute("data-sidebar") === "menu-sub-button";
      const isLabel =
        el.tagName === "SPAN" &&
        cls.includes("truncate") &&
        el.textContent &&
        el.textContent.length < 60;
      const hasGridRows = el.tagName === "DIV" && cls.includes("grid-rows-[");
      if (
        isProjectContainer ||
        isMenuButton ||
        isSubButton ||
        hasGridRows ||
        (isLabel && depth < 30)
      ) {
        outline.push({
          depth,
          tag: el.tagName,
          cls: cls.slice(0, 160),
          text: (el.textContent ?? "").trim().slice(0, 80),
          ariaExpanded: el.getAttribute("aria-expanded"),
          dataSidebar: el.getAttribute("data-sidebar"),
        });
      }
      for (const child of el.children) walk(child, depth + 1);
    };
    walk(sidebar, 0);
    return outline;
  });
  console.log(JSON.stringify(outline, null, 1));
} finally {
  await browser.close();
}
