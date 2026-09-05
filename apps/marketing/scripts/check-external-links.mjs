#!/usr/bin/env node
/**
 * check-external-links.mjs
 *
 * Walks every .mdx file under content/docs (plus src/data/product.ts and
 * src/lib/seo.ts, which are included whenever they contain external URLs) and
 * verifies every https:// URL with an HTTP GET:
 *   - follows up to 5 redirects
 *   - 15s timeout, UA "Mozilla/5.0"
 *   - 200-399 => pass
 *   - one retry on network errors / 429 / 5xx
 *   - hard failures (404, 410, refused-after-retry, persistent 5xx/429) exit non-zero
 *   - ALLOWLIST entries downgrade hard failures to warnings
 *
 * Concurrency is capped at 4. Designed to run in <2 minutes and be idempotent.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const UA = "Mozilla/5.0";
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const CONCURRENCY = 4;

/**
 * Known-flaky-but-legit URLs. A URL listed here that hard-fails is reported as
 * a warning instead of failing the run. Each entry needs a short comment.
 */
const ALLOWLIST = new Map([
  // x.ai blocks / rate-limits non-browser agents; the install scripts are real.
  [
    "https://x.ai/cli/install.sh",
    "x.ai CLI install script (macOS/Linux); x.ai occasionally rate-limits bot agents",
  ],
  [
    "https://x.ai/cli/install.ps1",
    "x.ai CLI install script (Windows); x.ai occasionally rate-limits bot agents",
  ],
  // x.com frequently returns 4xx/5xx to headless agents; the profile is real.
  ["https://x.com/emanueledpt", "X profile; x.com frequently throttles non-browser requests"],
  // pi.dev is a small personal-project domain; transient outages are expected.
  ["https://pi.dev/install.sh", "pi.dev install script; small domain, transient flakiness seen"],
  // youtube.com sometimes times out for non-browser agents; the channel is real.
  ["https://youtube.com/@emanueledpt", "YouTube channel; occasional ETIMEDOUT for headless agents"],
]);

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

function walkMdx(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkMdx(full, out);
    else if (entry.name.endsWith(".mdx")) out.push(full);
  }
  return out;
}

function collectFiles() {
  const files = walkMdx(join(ROOT, "content", "docs"));
  // Only include src files when they actually contain external URLs.
  for (const rel of ["src/data/product.ts", "src/lib/seo.ts"]) {
    const full = join(ROOT, rel);
    if (!statSync(full, { throwIfNoEntry: false })) continue;
    if (/(https?:\/\/)/.test(readFileSync(full, "utf8"))) files.push(full);
  }
  return files;
}

/** Strip markdown/trailing punctuation artifacts from a raw extracted URL. */
function cleanUrl(raw) {
  let u = raw.trim();
  // Trailing common punctuation that cannot belong to a URL path.
  u = u.replace(/[.,;:!?'"`]+$/, "");
  // Strip trailing ')' only when it is unbalanced (markdown link closer).
  for (;;) {
    const opens = (u.match(/\(/g) || []).length;
    const closes = (u.match(/\)/g) || []).length;
    if (u.endsWith(")") && closes > opens) u = u.slice(0, -1);
    else break;
  }
  u = u.replace(/[\]}]+$/, "");
  return u;
}

function extractUrls(text) {
  const urls = new Map(); // url -> Set(files)
  const re = /https?:\/\/[^\s<>"'`]+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    if (raw.startsWith("http://localhost")) continue;
    const clean = cleanUrl(raw);
    if (!/^https?:\/\//.test(clean)) continue;
    if (!urls.has(clean)) urls.set(clean, new Set());
    urls.get(clean).add("?");
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

async function fetchOnce(url) {
  let current = url;
  let redirects = 0;
  for (;;) {
    const res = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": UA, accept: "*/*" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return { status: res.status, finalUrl: current };
      current = new URL(loc, current).href;
      if (++redirects > MAX_REDIRECTS) {
        return { status: res.status, finalUrl: current, redirectLimit: true };
      }
      continue;
    }
    // Drain body so the connection is reusable.
    await res.arrayBuffer().catch(() => {});
    return { status: res.status, finalUrl: current };
  }
}

/** Returns { status, finalUrl, error } — one retry on network errors, 429, 5xx. */
async function checkUrl(url) {
  const attempts = [1, 2];
  for (const attempt of attempts) {
    try {
      const r = await fetchOnce(url);
      if (attempt === 1 && (r.status === 429 || r.status >= 500)) {
        await new Promise((res) => setTimeout(res, 750));
        continue; // retry once
      }
      return r;
    } catch (err) {
      if (attempt === 1) continue; // network error -> retry once
      const code = err?.cause?.code || err?.code || "";
      return {
        status: "ERR",
        finalUrl: url,
        error: err.message + (code ? ` (${code})` : ""),
      };
    }
  }
  return { status: "ERR", finalUrl: url, error: "unreachable" };
}

function classify(r) {
  if (typeof r.status === "number") {
    if (r.status >= 200 && r.status <= 399) return "PASS";
    if (r.status === 404 || r.status === 410) return "HARD";
    if (r.status === 429 || r.status >= 500) return "HARD"; // persistent after retry
    return "WARN"; // 401/403/451/… site is up but denies bots
  }
  return "HARD"; // network error / refused after retry
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const files = collectFiles();
const urlMap = new Map(); // url -> Set(source files)
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const [url] of extractUrls(text)) {
    if (!urlMap.has(url)) urlMap.set(url, new Set());
    urlMap.get(url).add(relative(ROOT, file));
  }
}

const urls = [...urlMap.keys()].sort();
const results = new Map();
let next = 0;

async function worker() {
  while (next < urls.length) {
    const url = urls[next++];
    results.set(url, await checkUrl(url));
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const rows = urls.map((url) => {
  const r = results.get(url);
  const cls = classify(r);
  const allowed = ALLOWLIST.has(url);
  const verdict = cls === "PASS" ? "PASS" : cls === "WARN" ? "WARN" : allowed ? "ALLOWED" : "FAIL";
  return {
    url,
    verdict,
    status: String(r.status),
    finalUrl: r.finalUrl,
    error: r.error || "",
    sources: [...urlMap.get(url)].join(", "),
  };
});

const w = (s, n) => String(s).padEnd(n).slice(0, n);
console.log("\nExternal link check — summary");
console.log("-".repeat(140));
console.log(`${w("URL", 70)} ${w("VERDICT", 8)} ${w("STATUS", 6)} ${w("FINAL URL", 44)} SOURCES`);
console.log("-".repeat(140));
for (const row of rows) {
  console.log(
    `${w(row.url, 70)} ${w(row.verdict, 8)} ${w(row.status, 6)} ${w(row.finalUrl, 44)} ${row.sources}` +
      (row.error ? `  [${row.error}]` : ""),
  );
}
console.log("-".repeat(140));

const pass = rows.filter((r) => r.verdict === "PASS").length;
const allowed = rows.filter((r) => r.verdict === "ALLOWED").length;
const warn = rows.filter((r) => r.verdict === "WARN").length;
const failed = rows.filter((r) => r.verdict === "FAIL").length;

console.log(
  `Checked ${rows.length} unique URLs across ${files.length} files: ${pass} pass, ${warn} warn, ${allowed} allowlisted, ${failed} fail.`,
);

if (warn.length > 0) {
  console.log("\nWarnings (non-fatal, site up but denied bot access):");
  for (const r of rows.filter((x) => x.verdict === "WARN"))
    console.log(`  - ${r.url} -> ${r.status}`);
}
if (allowed.length > 0) {
  console.log("\nAllowlisted (known-flaky-but-legit, downgraded from failure):");
  for (const r of rows.filter((x) => x.verdict === "ALLOWED"))
    console.log(`  - ${r.url} -> ${r.status} (${ALLOWLIST.get(r.url)})`);
}

if (failed.length > 0) {
  console.error("\nHARD FAILURES:");
  for (const r of rows.filter((x) => x.verdict === "FAIL"))
    console.error(`  - ${r.url} -> ${r.status}${r.error ? ` [${r.error}]` : ""} (${r.sources})`);
  process.exitCode = 1;
}
