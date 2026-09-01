// Debug: load the app, dump console messages, page errors, and basic DOM info.
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
const logs = [];
page.on("console", (m) => logs.push(`[console:${m.type()}] ${m.text().slice(0, 400)}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${String(e).slice(0, 600)}`));
page.on("requestfailed", (r) =>
  logs.push(`[requestfailed] ${r.url().slice(0, 200)} :: ${r.failure()?.errorText}`),
);
try {
  await page.goto(process.env.WEB_URL ?? "http://localhost:8837/", {
    waitUntil: "commit",
    timeout: 180000,
  });
  await page.waitForTimeout(20000);
  const info = await page.evaluate(() => ({
    url: location.href,
    readyState: document.readyState,
    bodyChildCount: document.body ? document.body.children.length : -1,
    hasSidebar: !!document.querySelector('[data-slot="sidebar"]'),
    hasRoot: !!document.getElementById("root"),
    rootHtmlLen: document.getElementById("root")
      ? document.getElementById("root").innerHTML.length
      : -1,
    title: document.title,
  }));
  console.log("INFO:", JSON.stringify(info));
} catch (e) {
  console.log("GOTO error:", String(e).slice(0, 300));
}
console.log("LOGS (last 40):");
for (const l of logs.slice(-40)) console.log(" ", l);
await page.screenshot({
  path: "/Users/user/synara-handoff-wt/plan-04/evidence/lane-04-restart/debug-after-load.png",
});
await browser.close();
