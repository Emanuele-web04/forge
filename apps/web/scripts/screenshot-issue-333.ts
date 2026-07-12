// Run from apps/web: bun scripts/screenshot-issue-333.ts
import * as FS from "node:fs";
import * as Path from "node:path";
import { chromium } from "playwright";

// Local-only output (gitignored via .synara-*/).
const outDir = Path.resolve("../../.synara-pr/issue-333");
const before = JSON.parse(FS.readFileSync(Path.join(outDir, "before-catalog.json"), "utf8")) as Array<{
  slug: string;
  name: string;
  upstreamProviderId?: string;
  upstreamProviderName?: string;
  supportedReasoningEfforts?: Array<{ value: string }>;
}>;
const after = JSON.parse(FS.readFileSync(Path.join(outDir, "after-catalog.json"), "utf8")) as typeof before;

function groupByProvider(models: typeof before) {
  const groups = new Map<string, typeof before>();
  for (const m of models) {
    const label = m.upstreamProviderName || m.upstreamProviderId || "Other";
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(m);
  }
  return groups;
}

function renderList(title: string, models: typeof before, xaiOnly: boolean) {
  const groups = groupByProvider(models);
  let html = `<div class="panel"><h2>${title}</h2><p class="meta">${models.length} picker rows</p>`;
  for (const [label, opts] of groups) {
    const isXai = /xai/i.test(label);
    if (xaiOnly && !isXai) continue;
    html += `<div class="group ${isXai ? "xai" : ""}"><div class="group-label">${label}</div><ul>`;
    for (const o of opts) {
      const efforts = (o.supportedReasoningEfforts || []).map((e) => e.value).join(", ");
      html += `<li><span class="name">${escapeHtml(o.name)}</span><span class="slug">${escapeHtml(o.slug)}</span>`;
      if (efforts) html += `<span class="efforts">efforts: ${escapeHtml(efforts)}</span>`;
      html += `</li>`;
    }
    html += `</ul></div>`;
  }
  html += `</div>`;
  return html;
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const styles = `
  body { font-family: ui-sans-serif, system-ui, sans-serif; background: #0f0f10; color: #f3f3f3; margin: 0; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; margin: 0 0 16px; }
  .row { display: flex; gap: 20px; align-items: flex-start; }
  .panel { flex: 1; background: #1a1a1c; border: 1px solid #2e2e32; border-radius: 12px; padding: 16px; max-height: 1100px; overflow: auto; }
  h2 { font-size: 14px; margin: 0 0 4px; }
  .meta { color: #9ca3af; font-size: 12px; margin: 0 0 12px; }
  .group { margin-bottom: 14px; }
  .group-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: #9ca3af; margin-bottom: 6px; }
  .group.xai .group-label { color: #a78bfa; }
  .group.xai { outline: 1px solid #6d28d9; border-radius: 8px; padding: 8px; background: #1f1530; }
  ul { list-style: none; margin: 0; padding: 0; }
  li { padding: 8px 10px; border-radius: 8px; margin-bottom: 4px; background: #242428; display: flex; flex-direction: column; gap: 2px; }
  .name { font-size: 13px; font-weight: 500; }
  .slug { font-size: 11px; color: #9ca3af; font-family: ui-monospace, monospace; }
  .efforts { font-size: 11px; color: #86efac; }
`;

function pageHtml(title: string, xaiOnly: boolean) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>${styles}</style></head><body>
  <h1>${title}</h1>
  <div class="row">
    ${renderList(`BEFORE — ${before.length} rows (base + raw variants)`, before, xaiOnly)}
    ${renderList(`AFTER — ${after.length} rows (collapsed)`, after, xaiOnly)}
  </div>
</body></html>`;
}

FS.writeFileSync(Path.join(outDir, "compare-xai.html"), pageHtml("Issue #333 — xAI / Grok (live cursor-agent)", true));
FS.writeFileSync(
  Path.join(outDir, "compare-full.html"),
  pageHtml("Issue #333 — full Cursor catalog (live cursor-agent)", false),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`file://${Path.join(outDir, "compare-xai.html")}`);
await page.waitForTimeout(400);
await page.screenshot({ path: Path.join(outDir, "before-after-xai.png"), fullPage: true });
await page.goto(`file://${Path.join(outDir, "compare-full.html")}`);
await page.waitForTimeout(400);
await page.screenshot({ path: Path.join(outDir, "before-after-full.png"), fullPage: true });
await browser.close();

// Relative paths only — never log absolute home directories.
console.log("Screenshots:");
console.log("  .synara-pr/issue-333/before-after-xai.png");
console.log("  .synara-pr/issue-333/before-after-full.png");
console.log(
  "xAI rows before/after:",
  before.filter((m) => m.upstreamProviderId === "xai").length,
  "→",
  after.filter((m) => m.upstreamProviderId === "xai").length,
);
