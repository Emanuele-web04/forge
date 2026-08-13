import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const port = Number(process.env.PERFORMANCE_PORT ?? 3212);
const url = `http://127.0.0.1:${port}/`;
const runs = Number(process.env.PERFORMANCE_RUNS ?? 1);
const nextBinary = fileURLToPath(new URL("../node_modules/.bin/next", import.meta.url));

const maximums = {
  ttfbMs: 800,
  domContentLoadedMs: 2_500,
  loadMs: 3_000,
  lcpMs: 2_500,
  cls: 0.1,
  totalEncodedBytes: 3_000_000,
  scriptEncodedBytes: 750_000,
  imageEncodedBytes: 2_250_000,
  requestCount: 100,
  longTaskTotalMs: 500,
  longTaskMaxMs: 200,
  domNodes: 2_500,
};

function startServer() {
  return spawn(nextBinary, ["start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    // Deterministic fixture mode, matching tests/performance/summary.json
    // ("fixtureMode": "VISUAL_TEST=1") and the e2e/visual/a11y webServers.
    // Without it the homepage renders live tweets whose 20 lazy below-the-fold
    // images are never requested within the measurement window, so every run
    // reports incompleteImages: 20.
    env: { ...process.env, VISUAL_TEST: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(server) {
  const deadline = Date.now() + 120_000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Production server exited with code ${server.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError ?? "no response"}`);
}

function stopServer(server) {
  return new Promise((resolve) => {
    if (server.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      server.kill("SIGKILL");
      resolve();
    }, 5_000);
    server.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.kill("SIGTERM");
  });
}

function rounded(value, digits = 0) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

async function runBrowserPerformanceAudit(browser) {
  const context = await browser.newContext({
    viewport: { width: 1_350, height: 940 },
    colorScheme: "light",
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const requests = new Map();
  const failedRequests = [];
  const httpErrors = [];
  const consoleErrors = [];
  const pageErrors = [];
  const encodedBytes = {
    total: 0,
    document: 0,
    script: 0,
    stylesheet: 0,
    image: 0,
    font: 0,
    other: 0,
  };

  await page.addInitScript(() => {
    window.__synaraPerformance = {
      lcpMs: 0,
      cls: 0,
      longTasks: [],
      layoutShifts: [],
    };

    function describeNode(node) {
      if (!(node instanceof Element)) return null;
      const id = node.id ? `#${node.id}` : "";
      const classes = [...node.classList]
        .slice(0, 3)
        .map((name) => `.${name}`)
        .join("");
      return `${node.tagName.toLowerCase()}${id}${classes}`;
    }

    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      const last = entries.at(-1);
      if (last) window.__synaraPerformance.lcpMs = last.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });

    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (!entry.hadRecentInput) {
          window.__synaraPerformance.cls += entry.value;
          window.__synaraPerformance.layoutShifts.push({
            value: entry.value,
            sources: (entry.sources ?? []).map((source) => ({
              node: describeNode(source.node),
              previousRect: source.previousRect,
              currentRect: source.currentRect,
            })),
          });
        }
      }
    }).observe({ type: "layout-shift", buffered: true });

    if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.__synaraPerformance.longTasks.push(entry.duration);
        }
      }).observe({ type: "longtask", buffered: true });
    }
  });

  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  cdp.on("Network.requestWillBeSent", (event) => {
    requests.set(event.requestId, {
      url: event.request.url,
      type: "Other",
      status: null,
    });
  });
  cdp.on("Network.responseReceived", (event) => {
    const request = requests.get(event.requestId);
    if (!request) return;
    request.type = event.type;
    request.status = event.response.status;
    if (event.response.status >= 400) {
      httpErrors.push({
        url: event.response.url,
        status: event.response.status,
        type: event.type,
      });
    }
  });
  cdp.on("Network.loadingFinished", (event) => {
    const request = requests.get(event.requestId);
    const bytes = Math.max(0, Number(event.encodedDataLength) || 0);
    encodedBytes.total += bytes;
    const type = request?.type ?? "Other";
    const bucket =
      {
        Document: "document",
        Script: "script",
        Stylesheet: "stylesheet",
        Image: "image",
        Font: "font",
      }[type] ?? "other";
    encodedBytes[bucket] += bytes;
  });
  cdp.on("Network.loadingFailed", (event) => {
    if (event.canceled) return;
    const request = requests.get(event.requestId);
    failedRequests.push({
      url: request?.url ?? "unknown",
      errorText: event.errorText,
      blockedReason: event.blockedReason ?? null,
    });
  });

  const response = await page.goto(url, {
    waitUntil: "load",
    timeout: 120_000,
  });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(750);

  const browserMetrics = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const paints = Object.fromEntries(
      performance.getEntriesByType("paint").map((entry) => [entry.name, entry.startTime]),
    );
    const longTasks = window.__synaraPerformance.longTasks;
    return {
      status: document.readyState,
      ttfbMs: navigation.responseStart - navigation.requestStart,
      domContentLoadedMs: navigation.domContentLoadedEventEnd - navigation.startTime,
      loadMs: navigation.loadEventEnd - navigation.startTime,
      firstContentfulPaintMs: paints["first-contentful-paint"] ?? 0,
      lcpMs: window.__synaraPerformance.lcpMs,
      cls: window.__synaraPerformance.cls,
      layoutShifts: window.__synaraPerformance.layoutShifts,
      longTaskCount: longTasks.length,
      longTaskTotalMs: longTasks.reduce((sum, duration) => sum + duration, 0),
      longTaskMaxMs: Math.max(0, ...longTasks),
      domNodes: document.getElementsByTagName("*").length,
      incompleteImages: [...document.images].filter(
        (image) => !image.complete || image.naturalWidth === 0,
      ).length,
      mainLandmarks: document.querySelectorAll("main").length,
      h1Count: document.querySelectorAll("h1").length,
    };
  });

  const result = {
    httpStatus: response?.status() ?? 0,
    ttfbMs: rounded(browserMetrics.ttfbMs),
    domContentLoadedMs: rounded(browserMetrics.domContentLoadedMs),
    loadMs: rounded(browserMetrics.loadMs),
    firstContentfulPaintMs: rounded(browserMetrics.firstContentfulPaintMs),
    lcpMs: rounded(browserMetrics.lcpMs),
    cls: rounded(browserMetrics.cls, 3),
    layoutShifts: browserMetrics.layoutShifts,
    longTaskCount: browserMetrics.longTaskCount,
    longTaskTotalMs: rounded(browserMetrics.longTaskTotalMs),
    longTaskMaxMs: rounded(browserMetrics.longTaskMaxMs),
    domNodes: browserMetrics.domNodes,
    incompleteImages: browserMetrics.incompleteImages,
    mainLandmarks: browserMetrics.mainLandmarks,
    h1Count: browserMetrics.h1Count,
    requestCount: requests.size,
    failedRequests,
    httpErrors,
    consoleErrors,
    pageErrors,
    encodedBytes,
  };

  await context.close();
  return result;
}

function violations(result) {
  const failures = [];
  for (const [metric, maximum] of Object.entries(maximums)) {
    const actual =
      metric === "totalEncodedBytes"
        ? result.encodedBytes.total
        : metric === "scriptEncodedBytes"
          ? result.encodedBytes.script
          : metric === "imageEncodedBytes"
            ? result.encodedBytes.image
            : result[metric];
    if (actual >= maximum) failures.push(`${metric}: ${actual} >= ${maximum}`);
  }
  if (result.httpStatus !== 200) failures.push(`httpStatus: ${result.httpStatus}`);
  if (result.incompleteImages !== 0) failures.push(`incompleteImages: ${result.incompleteImages}`);
  if (result.mainLandmarks !== 1) failures.push(`mainLandmarks: ${result.mainLandmarks}`);
  if (result.h1Count !== 1) failures.push(`h1Count: ${result.h1Count}`);
  if (result.failedRequests.length !== 0)
    failures.push(`failedRequests: ${result.failedRequests.length}`);
  if (result.httpErrors.length !== 0) failures.push(`httpErrors: ${result.httpErrors.length}`);
  if (result.consoleErrors.length !== 0)
    failures.push(`consoleErrors: ${result.consoleErrors.length}`);
  if (result.pageErrors.length !== 0) failures.push(`pageErrors: ${result.pageErrors.length}`);
  return failures;
}

const server = startServer();
let browser;
try {
  await waitForServer(server);
  browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });

  const warmup = await runBrowserPerformanceAudit(browser);
  const results = [];
  for (let index = 0; index < runs; index += 1) {
    results.push(await runBrowserPerformanceAudit(browser));
  }

  const evaluated = results.map((result) => ({
    ...result,
    violations: violations(result),
  }));
  const summary = {
    url,
    runs,
    engine: "Playwright Chromium + Chrome DevTools Protocol",
    browserVersion: browser.version(),
    viewport: { width: 1_350, height: 940 },
    warmup,
    results: evaluated,
    maximums,
    companionBlockingChecks: ["npm run test:a11y", "npm run test:seo-smoke", "npm run test:visual"],
  };
  const serializedSummary = `${JSON.stringify(summary, null, 2)}\n`;
  console.log(serializedSummary);

  const outputPath = process.env.PERFORMANCE_OUTPUT ?? "test-results/performance-summary.json";
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializedSummary);

  if (evaluated.some((result) => result.violations.length > 0)) {
    process.exitCode = 1;
  }
} finally {
  await browser?.close();
  await stopServer(server);
}
