// lane-04 restart evidence capture (PR 861: sidebar project expand/collapse persistence)
// Usage: node sidebar-restart-capture.mjs before|after
// Run with node; playwright is resolved from apps/web/node_modules via createRequire.
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";

const WEB_DIR = "/Users/user/synara-handoff-wt/plan-04/apps/web";
const EVIDENCE = "/Users/user/synara-handoff-wt/plan-04/evidence/lane-04-restart";
const MODE = process.argv[2] ?? "before";
const WEB_URL = process.env.WEB_URL ?? "http://localhost:8837/";
const USER_DATA_DIR = "/Users/user/synara-handoff-wt/plan-04/.synara-h04/browser-profile-h04";
const STORAGE_KEY = "synara:renderer-state:v8";

const require = createRequire(`${WEB_DIR}/package.json`);
const { chromium } = require("playwright");

const PROJECT_CONTAINER_SELECTOR = 'div[class*="group/collapsible"]';
const HEADER_BUTTON_SELECTOR = 'button[data-sidebar="menu-button"]';

/** DOM-state capture for every sidebar project section. Multi-signal: icon glyph,
 *  disclosure shell class + computed grid/opacity, content geometry. */
function collectSidebarState() {
  // Selectors are inlined as literals: this function is serialized into the
  // browser context and cannot close over module-scope constants.
  const PROJECT_CONTAINER_SELECTOR = 'div[class*="group/collapsible"]';
  const HEADER_BUTTON_SELECTOR = 'button[data-sidebar="menu-button"]';
  const containers = [...document.querySelectorAll(PROJECT_CONTAINER_SELECTOR)].filter((c) => {
    // Real project rows carry a data-project-hover-anchor; other collapsible
    // sections (e.g. "Chats") do not and must be excluded.
    if (!c.querySelector("[data-project-hover-anchor]")) return false;
    if (!c.querySelector(HEADER_BUTTON_SELECTOR)) return false;
    return [...c.querySelectorAll("div")].some(
      (d) =>
        typeof d.className === "string" &&
        (d.className.includes("grid-rows-[0fr]") || d.className.includes("grid-rows-[1fr]")),
    );
  });
  const projects = containers.map((container, index) => {
    const button = container.querySelector(HEADER_BUTTON_SELECTOR);
    const anchor = container.querySelector("[data-project-hover-anchor]");
    const nameSpan = [...button.querySelectorAll("span")].find((s) =>
      typeof s.className === "string" ? s.className.includes("truncate") : false,
    );
    const svg = button.querySelector("svg");
    const iconClass = svg ? (svg.getAttribute("class") ?? "") : "";
    const shell = [...container.querySelectorAll("div")].find(
      (d) =>
        typeof d.className === "string" &&
        (d.className.includes("grid-rows-[0fr]") || d.className.includes("grid-rows-[1fr]")),
    );
    const shellClass = shell ? shell.className : null;
    const shellStyle = shell ? getComputedStyle(shell) : null;
    const inner = shell ? shell.firstElementChild : null;
    const list = inner ? inner.firstElementChild : null;
    const listStyle = list ? getComputedStyle(list) : null;
    return {
      index,
      projectId: anchor ? anchor.getAttribute("data-project-hover-anchor") : null,
      name: nameSpan ? nameSpan.textContent : null,
      buttonText: button.textContent?.trim() ?? null,
      iconSvgClass: iconClass,
      iconGlyph: iconClass.includes("folder-open")
        ? "folder-open"
        : iconClass.includes("folder-closed")
          ? "folder-closed"
          : "unknown",
      disclosureShellClass: shellClass,
      computed: {
        shellGridTemplateRows: shellStyle ? shellStyle.gridTemplateRows : null,
        shellOpacity: shellStyle ? shellStyle.opacity : null,
        shellHeightPx: shell ? shell.getBoundingClientRect().height : null,
        listOffsetHeight: list ? list.offsetHeight : null,
        listOpacity: listStyle ? listStyle.opacity : null,
        listPointerEvents: listStyle ? listStyle.pointerEvents : null,
      },
      derivedExpanded:
        iconClass.includes("folder-open") ||
        (shellClass !== null && shellClass.includes("grid-rows-[1fr]")),
    };
  });
  const chatToggle = document.querySelector("button[aria-expanded]");
  return {
    capturedAt: new Date().toISOString(),
    url: location.href,
    origin: location.origin,
    projectCount: projects.length,
    projects,
    nonProjectToggles: chatToggle
      ? [
          {
            ariaExpanded: chatToggle.getAttribute("aria-expanded"),
            text: chatToggle.textContent?.trim() ?? null,
          },
        ]
      : [],
  };
}

const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
  headless: true,
  viewport: { width: 1440, height: 900 },
});
const page = browser.pages()[0] ?? (await browser.newPage());
page.setDefaultTimeout(60000);
const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});

try {
  await page.goto(WEB_URL, { waitUntil: "commit", timeout: 180000 });
  await page.waitForSelector('[data-slot="sidebar"]', { timeout: 180000 });

  // Wait for server snapshot hydration: project rows (or the add-project affordance) render.
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        'div[class*="group/collapsible"]:has([data-project-hover-anchor]) button[data-sidebar="menu-button"]',
      ).length > 0 || !!document.querySelector('button[aria-label="Add project"]'),
    undefined,
    { timeout: 60000 },
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        'div[class*="group/collapsible"]:has([data-project-hover-anchor]) button[data-sidebar="menu-button"]',
      ).length > 0,
    undefined,
    { timeout: 60000 },
  );
  await page.waitForTimeout(1500); // settle: WS snapshot -> store normalization -> render

  if (MODE === "before") {
    // Ensure at least 2 projects exist; create via the UI dialog if fewer.
    const target = 2;
    for (let i = 0; 0 === 0; i++) {
      const count = await page.evaluate(
        () =>
          document.querySelectorAll(
            'div[class*="group/collapsible"]:has([data-project-hover-anchor]) button[data-sidebar="menu-button"]',
          ).length,
      );
      if (count >= target || i >= 4) break;
      const paths = [
        "/Users/user/synara-handoff-wt/plan-04/.synara-h04/demo-project-alpha",
        "/Users/user/synara-handoff-wt/plan-04/.synara-h04/demo-project-beta",
      ];
      // Skip paths whose folder name already renders as a project row.
      const existingNames = await page.evaluate(() =>
        [
          ...document.querySelectorAll(
            'div[class*="group/collapsible"]:has([data-project-hover-anchor]) button[data-sidebar="menu-button"] span.truncate',
          ),
        ].map((s) => s.textContent?.trim() ?? ""),
      );
      const path = paths.find((p) => !existingNames.includes(p.split("/").at(-1)));
      if (!path) {
        console.log(`[before] no unused demo path left; existing=${JSON.stringify(existingNames)}`);
        break;
      }
      console.log(`[before] only ${count} project(s); creating via UI: ${path}`);
      // The section toolbar is hover-revealed (md:opacity-0 + pointer-events-none
      // until group-hover/project-header), so hover the header row first.
      const addBtn = page.locator('button[aria-label="Add project"]');
      const sectionHeader = addBtn.locator(
        'xpath=ancestor::div[contains(@class,"group/project-header")][1]',
      );
      await sectionHeader.hover();
      await page.waitForTimeout(300);
      await addBtn.click();
      await page.waitForSelector('input[aria-label="Project folder path"]', { timeout: 30000 });
      await page.fill('input[aria-label="Project folder path"]', path);
      await page.getByRole("button", { name: "Create project", exact: true }).click();
      // Wait for the dialog to close and the new project row to render.
      await page.waitForFunction(
        (prev) =>
          document.querySelectorAll(
            'div[class*="group/collapsible"]:has([data-project-hover-anchor]) button[data-sidebar="menu-button"]',
          ).length > prev,
        count,
        { timeout: 60000 },
      );
      await page.waitForTimeout(1000);
    }

    // Collapse every expanded project section by clicking its header toggle.
    for (let round = 0; round < 10; round++) {
      const expandedFlags = await page.$$eval('div[class*="group/collapsible"]', (containers) => {
        return containers
          .filter((c) => c.querySelector("[data-project-hover-anchor]"))
          .filter((c) => c.querySelector('button[data-sidebar="menu-button"]'))
          .map((c) => {
            const shell = [...c.querySelectorAll("div")].find(
              (d) =>
                typeof d.className === "string" &&
                (d.className.includes("grid-rows-[0fr]") ||
                  d.className.includes("grid-rows-[1fr]")),
            );
            return shell && shell.className.includes("grid-rows-[1fr]") ? true : false;
          });
      });
      const anyExpanded = expandedFlags.some(Boolean);
      const expandedIdx = expandedFlags.findIndex(Boolean);
      if (!anyExpanded) {
        console.log(`[before] all project sections collapsed (round ${round})`);
        break;
      }
      const containers = await page.$$(PROJECT_CONTAINER_SELECTOR);
      const filtered = [];
      for (const c of containers) {
        const isProject = (await c.$("[data-project-hover-anchor]")) !== null;
        const hasHeader = (await c.$(HEADER_BUTTON_SELECTOR)) !== null;
        if (isProject && hasHeader) filtered.push(c);
      }
      const targetContainer = filtered[expandedIdx];
      const button = await targetContainer.$(HEADER_BUTTON_SELECTOR);
      await button.scrollIntoViewIfNeeded();
      await button.click();
      console.log(`[before] clicked project toggle at index ${expandedIdx}`);
      await page.waitForTimeout(600); // 220ms disclosure animation + debounce margin
    }

    // Wait for the debounced (500ms) localStorage write.
    await page.waitForFunction((key) => window.localStorage.getItem(key) !== null, STORAGE_KEY, {
      timeout: 30000,
    });
    await page.waitForTimeout(800);
  } else {
    // AFTER mode: no interaction with any toggle. Let hydration + normalization settle.
    await page.waitForTimeout(2500);
  }

  const sidebarState = await page.evaluate(collectSidebarState);
  const localStorageRaw = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    STORAGE_KEY,
  );
  const localStorageAllKeys = await page.evaluate(() => Object.keys(window.localStorage));

  const suffix = MODE;
  writeFileSync(
    `${EVIDENCE}/collapsed-state-${suffix}.json`,
    JSON.stringify(sidebarState, null, 2) + "\n",
  );
  writeFileSync(
    `${EVIDENCE}/localStorage-${suffix}.json`,
    JSON.stringify(
      {
        origin: sidebarState.origin,
        url: sidebarState.url,
        key: STORAGE_KEY,
        rawValue: localStorageRaw,
        parsedValue: localStorageRaw ? JSON.parse(localStorageRaw) : null,
        allLocalStorageKeys: localStorageAllKeys,
      },
      null,
      2,
    ) + "\n",
  );
  await page.screenshot({
    path: `${EVIDENCE}/collapsed-${suffix === "before" ? "before" : "after"}-restart.png`,
  });

  console.log(`[${MODE}] projectCount=${sidebarState.projectCount}`);
  for (const p of sidebarState.projects) {
    console.log(
      `[${MODE}] project "${p.name}" icon=${p.iconGlyph} shellRows=${p.computed.shellGridTemplateRows} shellOpacity=${p.computed.shellOpacity} derivedExpanded=${p.derivedExpanded}`,
    );
  }
  console.log(`[${MODE}] localStorage raw: ${localStorageRaw}`);
  if (consoleErrors.length > 0) {
    console.log(`[${MODE}] console errors (${consoleErrors.length}):`);
    for (const e of consoleErrors.slice(0, 10)) console.log(`  - ${e.slice(0, 300)}`);
  }
} finally {
  await browser.close();
}
console.log(`[${MODE}] done`);
