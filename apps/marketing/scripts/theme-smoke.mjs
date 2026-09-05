// Runs the actual inline theme initializer in isolated Chromium documents.
// node apps/marketing/scripts/theme-smoke.mjs [ThemeScript.tsx] [report.json]
// SYNARA_PERF=1 records an older baseline without asserting idle behavior.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const source = readFileSync(
  process.argv[2] ?? new URL("../src/components/ThemeScript.tsx", import.meta.url),
  "utf8",
);
const key = source.match(/const THEME_KEY = "([^"]+)";/)?.[1];
const template = source.match(/const themeInit = `([\s\S]*?)`;/)?.[1];
assert(key && template, "Theme initializer must be present");
const script = template.replace("${JSON.stringify(THEME_KEY)}", JSON.stringify(key));
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const stored of ["dark", "light", null]) {
    const context = await browser.newContext({ colorScheme: "dark" });
    try {
      await context.route("http://127.0.0.1/theme-probe", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: '<!doctype html><html class="base"><body>Theme probe</body></html>',
        }),
      );
      const page = await context.newPage();
      await page.goto("http://127.0.0.1/theme-probe");
      await page.evaluate(
        ({ script, key, stored }) => {
          if (stored !== null) localStorage.setItem(key, stored);
          const metrics = (window.__themeMetrics = { observerCallbacks: 0, timerCallbacks: 0 });
          const Observer = window.MutationObserver;
          window.MutationObserver = class extends Observer {
            constructor(callback) {
              super((records, observer) => {
                metrics.observerCallbacks += 1;
                callback(records, observer);
              });
            }
          };
          const timeout = window.setTimeout.bind(window);
          window.setTimeout = (callback, delay, ...args) =>
            timeout(() => {
              metrics.timerCallbacks += 1;
              callback(...args);
            }, delay);
          (0, eval)(script);
          window.dispatchEvent(new Event("load"));
        },
        { script, key, stored },
      );
      await page.waitForTimeout(1_100);
      const metrics = await page.evaluate(() => window.__themeMetrics);
      const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
      const expectedDark = stored !== "light";
      assert.equal(await isDark(), expectedDark);
      if (process.env.SYNARA_PERF !== "1") {
        assert.equal(
          metrics.observerCallbacks,
          0,
          "Theme must not observe its own repeated writes",
        );
        assert.equal(metrics.timerCallbacks, 2, "Only load and initial settling timers should run");
      }
      await page.evaluate(() => {
        document.documentElement.className = "hydrated";
      });
      await page.waitForTimeout(40);
      assert.equal(await isDark(), expectedDark);
      assert(await page.evaluate(() => document.documentElement.classList.contains("hydrated")));
      await page.evaluate((key) => {
        const next = !document.documentElement.classList.contains("dark");
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem(key, next ? "dark" : "light");
      }, key);
      await page.waitForTimeout(40);
      assert.equal(await isDark(), !expectedDark);
      await page.emulateMedia({ colorScheme: "light" });
      await page.waitForTimeout(40);
      assert.equal(await isDark(), !expectedDark);
      await page.evaluate((key) => localStorage.removeItem(key), key);
      for (const colorScheme of ["dark", "light"]) {
        await page.emulateMedia({ colorScheme });
        await page.waitForTimeout(40);
        assert.equal(await isDark(), colorScheme === "dark");
      }
      results.push({ stored, ...metrics, behaviorPassed: true });
    } finally {
      await context.close();
    }
  }
  const report = JSON.stringify(
    { browser: browser.version(), idleWindowMs: 1_100, results },
    null,
    2,
  );
  if (process.argv[3]) writeFileSync(process.argv[3], report);
  console.log(report);
} finally {
  await browser.close();
}
