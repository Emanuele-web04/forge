// Usage: node perf/concurrent-runner.mjs <artifact-directory> [baseline|paired|final]
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
const artifacts = resolve(process.argv[2]);
const paired = process.argv[3] === "paired";
let activeVariant = "baseline";
const server = createServer((req, res) => {
  const pathname = new URL(req.url, "http://localhost").pathname;
  const path = resolve(
    artifacts,
    "." +
      (pathname.startsWith("/assets/") || pathname.startsWith("/central-icons")
        ? "/" + activeVariant + "-dist" + pathname
        : pathname),
  );
  if (!path.startsWith(artifacts + "/")) {
    res.writeHead(403).end();
    return;
  }
  try {
    const data = readFileSync(path);
    res.setHeader(
      "Content-Type",
      {
        ".js": "text/javascript",
        ".css": "text/css",
        ".html": "text/html",
        ".svg": "image/svg+xml",
        ".wasm": "application/wasm",
      }[extname(path)] ?? "application/octet-stream",
    );
    res.end(data);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: false, args: ["--disable-extensions"] });
const browserCDP = await browser.newBrowserCDPSession();
const results = [];
const variants = paired
  ? ["baseline", "optimized"]
  : [process.argv[3] === "final" ? "final" : "baseline"];
try {
  for (let repeat = 0; repeat < (paired ? 3 : 1); repeat++)
    for (const mode of ["hidden", "visible"])
      for (const threads of paired ? [1, 5, 10] : [10]) {
        for (const variant of repeat % 2 ? [...variants].reverse() : variants) {
          activeVariant = variant;
          const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (e) => {
            errors.push(e.message);
            console.error(e.message);
          });
          await page.goto(
            `http://127.0.0.1:${server.address().port}/${variant}-dist/perf/concurrent.html?threads=${threads}&mode=${mode}`,
          );
          await page.waitForFunction(() => window.__synaraConcurrentPerf);
          await page.waitForTimeout(2000);
          await page.evaluate(() => window.__synaraConcurrentPerf.run(10));
          const cdp = await context.newCDPSession(page);
          await cdp.send("Performance.enable");
          await cdp.send("HeapProfiler.collectGarbage");
          const before = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
          );
          const cpuBefore = (await browserCDP.send("SystemInfo.getProcessInfo")).processInfo;
          const report = await page.evaluate(() => window.__synaraConcurrentPerf.run(60));
          const cpuAfter = (await browserCDP.send("SystemInfo.getProcessInfo")).processInfo;
          const after = Object.fromEntries(
            (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
          );
          const cpuSeconds = {};
          for (const proc of cpuAfter) {
            const prev = cpuBefore.find((p) => p.id === proc.id);
            if (prev)
              cpuSeconds[proc.type] = (cpuSeconds[proc.type] ?? 0) + proc.cpuTime - prev.cpuTime;
          }
          const rssKB = {};
          for (const proc of cpuAfter) {
            try {
              const rss = Number(
                execFileSync("ps", ["-o", "rss=", "-p", String(proc.id)], {
                  encoding: "utf8",
                }).trim(),
              );
              rssKB[proc.type] = (rssKB[proc.type] ?? 0) + rss;
            } catch {}
          }
          await cdp.send("HeapProfiler.collectGarbage");
          const retained = (await cdp.send("Runtime.getHeapUsage")).usedSize;
          const result = {
            repeat,
            variant,
            ...report,
            errors,
            cpuSeconds,
            rssKB,
            taskMs: (after.TaskDuration - before.TaskDuration) * 1000,
            scriptMs: (after.ScriptDuration - before.ScriptDuration) * 1000,
            layoutMs: (after.LayoutDuration - before.LayoutDuration) * 1000,
            heapBefore: before.JSHeapUsedSize,
            heapAfter: after.JSHeapUsedSize,
            heapRetained: retained,
          };
          results.push(result);
          console.log(JSON.stringify(result));
          writeFileSync(
            join(artifacts, paired ? "paired-browser.json" : `${variants[0]}-probe.json`),
            JSON.stringify(results, null, 2),
          );
          await context.close();
        }
      }
} finally {
  await browser.close();
  server.close();
}
