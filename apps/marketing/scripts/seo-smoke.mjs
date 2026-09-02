import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOST = "127.0.0.1";
const PORT = Number(process.env.SEO_SMOKE_PORT ?? 3210);
const ORIGIN = `http://${HOST}:${PORT}`;
const NEXT_CLI = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");

let output = "";
const server = spawn(process.execPath, [NEXT_CLI, "start", "-H", HOST, "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: "production" },
  stdio: ["ignore", "pipe", "pipe"],
});

for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForServer() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Next.js exited before becoming ready.\n${output}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/`, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await delay(500);
  }
  throw new Error(`Timed out waiting for ${ORIGIN}.\n${output}`);
}

async function getRoute(pathname, expectedContentType) {
  const response = await fetch(`${ORIGIN}${pathname}`, {
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${pathname} returned ${response.status}\n${body}`);
  assert.match(
    response.headers.get("content-type") ?? "",
    expectedContentType,
    `${pathname} returned the wrong content type`,
  );
  return { body, response };
}

async function readRoute(pathname, expectedContentType) {
  const route = await getRoute(pathname, expectedContentType);
  return route.body;
}

async function stopServer() {
  if (server.exitCode !== null) return;

  const exited = new Promise((resolve) => server.once("exit", resolve));
  server.kill("SIGTERM");
  await Promise.race([exited, delay(5_000)]);

  if (server.exitCode === null) {
    server.kill("SIGKILL");
    await Promise.race([exited, delay(2_000)]);
  }

  server.stdout.destroy();
  server.stderr.destroy();
}

try {
  await waitForServer();

  const homepage = await readRoute("/", /text\/html/i);
  for (const marker of [
    "Run every coding agent in one workspace",
    "The local-first workspace and control plane for coding agents.",
    "Star on GitHub",
    "Free and open source",
    "One workspace. Separate tasks. Shared control.",
    "Keep execution and verification in the same loop.",
    "Know where every part of the work goes.",
  ]) {
    assert.ok(homepage.includes(marker), `homepage is missing ${marker}`);
  }
  for (const retired of [
    ["no longer just a ", "t", "3", " code fork"].join(""),
    "Opus 4.8",
    "GPT-5.5",
    "Composer 2.5",
    "500+ models",
    "The command center for agentic development",
  ]) {
    assert.equal(
      homepage.toLowerCase().includes(retired.toLowerCase()),
      false,
      `homepage still renders retired copy: ${retired}`,
    );
  }
  assert.match(
    homepage,
    /<title>Synara — AI Coding Workspace for Claude Code, Codex &amp; Cursor<\/title>/,
  );
  assert.match(
    homepage,
    /<link rel="canonical" href="https:\/\/www\.trysynara\.com"\/>/,
    "homepage must emit the exact canonical production origin",
  );
  assert.ok(homepage.includes('"@type":"SoftwareApplication"'));
  assert.ok(homepage.includes('"@type":"FAQPage"'));

  const install = await readRoute("/install", /text\/html/i);
  assert.ok(install.includes("Download Synara"));
  assert.ok(install.includes("coding-agent runtime already authenticated"));
  assert.match(install, /<title>Download Synara — Coding Agent Workspace<\/title>/);

  const docs = await readRoute("/docs", /text\/html/i);
  assert.match(
    docs,
    /<link rel="canonical" href="https:\/\/www\.trysynara\.com\/docs"/,
    "docs page is missing its absolute self-canonical",
  );
  assert.match(docs, /property="og:type" content="website"/);
  assert.match(docs, /property="og:image"/);
  assert.match(docs, /name="twitter:card" content="summary_large_image"/);
  assert.ok(docs.includes('"@type":"TechArticle"'), "docs page is missing TechArticle JSON-LD");
  assert.ok(docs.includes('"@type":"BreadcrumbList"'), "docs page is missing breadcrumb JSON-LD");

  const docsIndexMarkdown = await readRoute("/docs.md", /text\/markdown/i);
  assert.ok(docsIndexMarkdown.includes("# Synara documentation"));
  assert.ok(docsIndexMarkdown.includes("## What is Synara?"));

  const { body: docsMarkdown, response: docsMarkdownResponse } = await getRoute(
    "/docs/providers/claude-code.md",
    /text\/markdown/i,
  );
  assert.equal(docsMarkdownResponse.headers.get("x-robots-tag"), "noindex, follow");
  assert.equal(
    docsMarkdownResponse.headers.get("link"),
    '<https://www.trysynara.com/docs/providers/claude-code>; rel="canonical"',
  );
  for (const marker of [
    "# Claude Code",
    "Canonical URL: https://www.trysynara.com/docs/providers/claude-code",
    "## Install",
    "claude --version",
  ]) {
    assert.ok(docsMarkdown.includes(marker), `Markdown documentation is missing ${marker}`);
  }
  assert.equal(docsMarkdown.includes("<html"), false);

  for (const pathname of [
    "/docs/providers",
    "/docs/workflows",
    "/docs/troubleshooting",
    "/docs/troubleshooting/report-a-problem",
  ]) {
    const html = await readRoute(pathname, /text\/html/i);
    assert.ok(html.includes('"@type":"TechArticle"'), `${pathname} lacks article JSON-LD`);
  }

  const robots = await readRoute("/robots.txt", /text\/plain/i);
  for (const marker of [
    "User-Agent: OAI-SearchBot",
    "User-Agent: ChatGPT-User",
    "User-Agent: Claude-SearchBot",
    "User-Agent: Claude-User",
    "User-Agent: PerplexityBot",
    "User-Agent: GPTBot",
    "Disallow: /api/",
    "Sitemap: https://www.trysynara.com/sitemap-index.xml",
  ]) {
    assert.ok(robots.includes(marker), `robots.txt is missing ${marker}`);
  }

  const sitemapIndex = await readRoute("/sitemap-index.xml", /application\/xml/i);
  assert.equal(
    (sitemapIndex.match(/<sitemap>/g) ?? []).length,
    2,
    "sitemap index must contain the main and changelog sitemaps",
  );
  assert.ok(sitemapIndex.includes("https://www.trysynara.com/sitemap.xml"));
  assert.ok(sitemapIndex.includes("https://www.trysynara.com/changelog/sitemap.xml"));

  const sitemap = await readRoute("/sitemap.xml", /application\/xml/i);
  for (const route of [
    "/docs",
    "/docs/providers/claude-code",
    "/docs/workflows/agent-gateway",
    "/docs/troubleshooting/report-a-problem",
  ]) {
    assert.ok(
      sitemap.includes(`https://www.trysynara.com${route}`),
      `sitemap.xml is missing ${route}`,
    );
  }
  for (const utilityPath of ["/llms.txt", "/llms-full.txt", "/ai.txt"]) {
    assert.equal(
      sitemap.includes(`https://www.trysynara.com${utilityPath}`),
      false,
      `sitemap.xml should not advertise ${utilityPath} as a search-result page`,
    );
  }

  const llms = await readRoute("/llms.txt", /text\/plain/i);
  for (const marker of [
    "The local-first workspace and control plane for coding agents.",
    "## Product model",
    "One task owns one line of work",
    "## Documentation index",
    "https://www.trysynara.com/docs/providers.md",
    "https://www.trysynara.com/docs/workflows.md",
    "https://www.trysynara.com/docs/troubleshooting.md",
    "robots.txt and page-level indexing directives remain authoritative",
  ]) {
    assert.ok(llms.includes(marker), `llms.txt is missing ${marker}`);
  }

  const llmsFull = await readRoute("/llms-full.txt", /text\/plain/i);
  assert.ok(llmsFull.includes("## Full documentation"));
  assert.ok(llmsFull.includes("# Report a problem"));
  assert.ok(
    llmsFull.includes(
      "Canonical URL: https://www.trysynara.com/docs/troubleshooting/report-a-problem",
    ),
  );
  assert.ok(llmsFull.includes("claude --version"));

  const ai = await readRoute("/ai.txt", /text\/plain/i);
  assert.ok(ai.includes("AI search and user-directed retrieval agents:"));
  assert.ok(ai.includes("Model-development controls, separate from search visibility:"));
  assert.ok(ai.includes("Supported runtimes: Claude Code, Codex, OpenCode"));
  assert.ok(ai.includes("Markdown documentation: https://www.trysynara.com/docs.md"));
  assert.ok(
    ai.includes("This file is informational and does not grant or revoke crawler permission."),
  );

  console.log("Marketing, SEO, AEO, and AI discovery smoke test passed.");
} finally {
  await stopServer();
}
