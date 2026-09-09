// Isolated macOS status-animation probe: node apps/web/perf/status-animation-runner.mjs <artifacts>.
// Expects baseline-dist and status-dist production perf builds inside <artifacts>.
// Uses synthetic content and its own Electron profile; never connects to Synara or a provider.
import { createRequire } from "node:module";
import { writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const artifacts = resolve(process.argv[2]);
const require = createRequire(join(root, "apps/web/package.json"));
const { _electron } = require("playwright");
const electronPath = createRequire(join(root, "apps/desktop/package.json"))("electron");
const assets = join(artifacts, "baseline-dist/assets");
const css = readdirSync(assets)
  .filter((file) => file.endsWith(".css"))
  .sort((a, b) => statSync(join(assets, b)).size - statSync(join(assets, a)).size)[0];
const fixture = join(artifacts, "status.html");
writeFileSync(
  fixture,
  `<!doctype html><html class="dark"><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(join(assets, css))}">
<style>
html,body{margin:0;width:100%;height:100%;background:transparent;color:#ddd;font:14px system-ui}
aside{position:absolute;inset:0 auto 0 0;width:270px;background:rgba(25,25,25,.6);backdrop-filter:blur(20px);padding:55px 16px}
main{position:absolute;inset:0 0 0 270px;background:#1b1b1d;padding:55px 40px}
.composer{position:absolute;bottom:20px;left:36px;right:36px;height:130px;border-radius:24px;background:rgba(35,35,38,.55);backdrop-filter:var(--composer-glass-filter)}
.work{position:absolute;bottom:75px;left:45px;right:45px;font-size:15px}
.history{max-width:650px;line-height:2.2;color:#999}
</style><aside><strong>Synara</strong><div style="margin-top:30px;display:flex;gap:10px;align-items:center">
<svg class="animate-spin-stepped motion-reduce:animate-none" viewBox="0 0 15 15" fill="none" style="width:12px;height:12px;color:#999">
<circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" stroke-opacity=".22" stroke-width="1.4"/>
<circle cx="7.5" cy="7.5" r="6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="22.870794518133697 40.840704496667314" stroke-dashoffset="-6.53451271946677"/>
</svg><span>One running thread</span></div></aside>
<main><h1>Performance fixture</h1><div class="history">${Array.from({ length: 8 }, (_, i) => `<p>Settled message ${i + 1}: representative static transcript content, with no incoming tokens.</p>`).join("")}</div>
<div class="work shimmer">Working…</div><div class="composer"></div></main></html>`,
);
const entry = join(artifacts, "status-main.cjs");
writeFileSync(
  entry,
  `const { app, BrowserWindow } = require("electron");
app.setPath("userData", ${JSON.stringify(join(artifacts, "electron-profile"))});
app.whenReady().then(() => {
 const win = new BrowserWindow({width:1200,height:850,title:"Synara performance fixture",show:true,
 vibrancy:"under-window",visualEffectState:"followWindow",backgroundColor:"#00000000",
 webPreferences:{sandbox:true,backgroundThrottling:true}});
 win.loadFile(${JSON.stringify(fixture)});
});
app.on("window-all-closed", () => app.quit());`,
);
const app = await _electron.launch({
  executablePath: electronPath,
  args: [entry],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: "" },
});
const page = await app.firstWindow();
const samples = [];
try {
  for (let repeat = 0; repeat < 3; repeat++) {
    for (const variant of repeat % 2 ? ["optimized", "baseline"] : ["baseline", "optimized"]) {
      await page.goto(pathToFileURL(fixture).href);
      if (variant === "optimized") {
        const finalAssets = join(artifacts, "status-dist/assets");
        const finalCss = readdirSync(finalAssets)
          .filter((f) => f.endsWith(".css"))
          .sort(
            (a, b) => statSync(join(finalAssets, b)).size - statSync(join(finalAssets, a)).size,
          )[0];
        await page.evaluate(
          (href) => {
            document.querySelector('link[rel="stylesheet"]').href = href;
          },
          pathToFileURL(join(finalAssets, finalCss)).href,
        );
        await page.waitForFunction(() =>
          getComputedStyle(document.querySelector(".shimmer")).animationTimingFunction.includes(
            "40",
          ),
        );
      }
      const timing = await page.evaluate((variant) => {
        for (const el of document.querySelectorAll(
          variant === "optimized" ? ".animate-spin-stepped,.shimmer" : ".animate-spin-stepped",
        ))
          for (const animation of el.getAnimations()) animation.startTime = 0;
        return [...document.querySelectorAll(".animate-spin-stepped,.shimmer")].map((el) => ({
          className: el.getAttribute("class"),
          computedTiming: getComputedStyle(el).animationTimingFunction,
          animations: el
            .getAnimations()
            .map((a) => ({ startTime: a.startTime, ...a.effect.getTiming() })),
        }));
      }, variant);
      if (timing.some((t) => t.animations.length !== 1)) throw Error("Missing fixture animation");
      await new Promise((r) => setTimeout(r, 2000));
      const before = await app.evaluate(({ app }) => app.getAppMetrics());
      const start = performance.now();
      await new Promise((r) => setTimeout(r, 8000));
      const metrics = await app.evaluate(({ app }) =>
        app
          .getAppMetrics()
          .map((m) => ({ pid: m.pid, type: m.type, cpu: m.cpu, memory: m.memory })),
      );
      const elapsedMs = performance.now() - start;
      const cpuSeconds = Object.fromEntries(
        metrics.map((m) => [
          m.type,
          m.cpu.cumulativeCPUUsage -
            (before.find((p) => p.pid === m.pid)?.cpu.cumulativeCPUUsage ??
              m.cpu.cumulativeCPUUsage),
        ]),
      );
      const row = { repeat, variant, elapsedMs, timing, metrics, cpuSeconds };
      samples.push(row);
      console.log(JSON.stringify(row));
      writeFileSync(join(artifacts, "status-final-paired.json"), JSON.stringify(samples, null, 2));
    }
  }
  await page.screenshot({ path: join(artifacts, "status-final-fixture.png") });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotion = await page.evaluate(() =>
    [...document.querySelectorAll(".animate-spin-stepped,.shimmer")].map((el) => ({
      className: el.getAttribute("class"),
      animations: el.getAnimations().length,
      color: getComputedStyle(el).color,
      textFill: getComputedStyle(el).webkitTextFillColor,
    })),
  );
  if (
    reducedMotion.some((m) => m.animations !== 0) ||
    reducedMotion[1].color !== reducedMotion[1].textFill
  )
    throw Error("Reduced motion regression");
  writeFileSync(
    join(artifacts, "status-reduced-motion.json"),
    JSON.stringify(reducedMotion, null, 2),
  );
} finally {
  await app.close();
}
