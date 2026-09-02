import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseFrontmatter } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_ROOT = path.join(ROOT, "content", "docs");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

function walk(directory, predicate) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    const absolute = path.join(directory, entry);
    if (statSync(absolute).isDirectory()) files.push(...walk(absolute, predicate));
    else if (predicate(absolute)) files.push(absolute);
  }
  return files;
}

test("documentation titles and descriptions are unique and answer-ready", () => {
  const titles = new Map();
  const descriptions = new Map();

  for (const file of walk(DOCS_ROOT, (entry) => entry.endsWith(".mdx"))) {
    const relative = path.relative(ROOT, file);
    const parsed = parseFrontmatter(readFileSync(file, "utf8"));
    assert.equal(parsed.error, undefined, `${relative} has invalid frontmatter`);

    const title = parsed.values.title?.trim();
    const description = parsed.values.description?.trim();
    assert.ok(title, `${relative} needs a title`);
    assert.ok(description, `${relative} needs a description`);
    assert.ok(description.length >= 35, `${relative} description is too thin`);
    assert.ok(description.length <= 220, `${relative} description is too long`);
    assert.equal(description.includes("\n"), false, `${relative} description must be one line`);

    assert.equal(
      titles.has(title.toLowerCase()),
      false,
      `${relative} duplicates title in ${titles.get(title.toLowerCase())}`,
    );
    assert.equal(
      descriptions.has(description.toLowerCase()),
      false,
      `${relative} duplicates description in ${descriptions.get(description.toLowerCase())}`,
    );
    titles.set(title.toLowerCase(), relative);
    descriptions.set(description.toLowerCase(), relative);
  }
});

test("the documentation landing page answers high-intent questions directly", () => {
  const source = read("content/docs/index.mdx");
  for (const heading of [
    "What is Synara?",
    "What does Synara control?",
    "Does Synara include model access?",
    "Does Synara upload code to its own cloud?",
    "How should I run my first task?",
    "How do I run several agents safely?",
    "Where do I go when something fails?",
  ]) {
    assert.match(source, new RegExp(`^## ${heading.replace(/[?]/g, "\\?")}$`, "m"));
  }

  for (const route of ["/docs/providers", "/docs/workflows", "/docs/troubleshooting"]) {
    assert.ok(source.includes(route), `docs landing page does not link to ${route}`);
  }
});

test("AI-readable indexes are generated from the canonical Fumadocs catalog", () => {
  const docsSource = read("src/lib/docs.ts");
  const llmText = read("src/lib/llmText.ts");
  const sourceConfig = read("source.config.ts");
  const nextConfig = read("next.config.ts");
  const markdownRoute = read("src/app/llms.mdx/docs/[[...slug]]/route.ts");
  const docsMarkdown = read("src/lib/docsMarkdown.ts");

  assert.ok(docsSource.includes("getDocumentationCatalog"));
  assert.match(docsSource, /docsSource\s*\.\s*getPages\s*\(\s*\)/);
  assert.ok(sourceConfig.includes("includeProcessedMarkdown: true"));
  assert.ok(nextConfig.includes('source: "/docs/:path*.md"'));
  assert.ok(nextConfig.includes('destination: "/llms.mdx/docs/:path*"'));
  assert.ok(markdownRoute.includes("buildDocumentationMarkdown"));
  assert.ok(markdownRoute.includes('"Content-Type": "text/markdown; charset=utf-8"'));
  assert.ok(docsMarkdown.includes('getText("processed")'));
  assert.ok(llmText.includes("getDocumentationCatalog"));
  assert.ok(llmText.includes("documentationIndexLines"));
  assert.ok(llmText.includes("buildDocumentationCorpus"));
  assert.equal(
    llmText.includes("const CORE_PAGES"),
    false,
    "AI index must not use the retired hand-maintained docs list",
  );
  assert.ok(llmText.includes("AI_DISCOVERY_NOTICE"));
  assert.ok(llmText.includes("robots.txt and page-level robots directives"));
});

test("crawler policy separates search visibility from model training", () => {
  const discovery = read("src/lib/discovery.ts");
  const robots = read("src/app/robots.ts");

  for (const agent of [
    "OAI-SearchBot",
    "ChatGPT-User",
    "Claude-SearchBot",
    "Claude-User",
    "PerplexityBot",
  ]) {
    assert.ok(discovery.includes(`\"${agent}\"`), `missing discovery crawler ${agent}`);
  }

  for (const agent of ["GPTBot", "ClaudeBot", "Google-Extended"]) {
    assert.ok(discovery.includes(`\"${agent}\"`), `missing training control ${agent}`);
  }

  assert.ok(robots.includes("AI_DISCOVERY_USER_AGENTS"));
  assert.ok(robots.includes("AI_TRAINING_USER_AGENTS"));
  assert.ok(robots.includes("disallow: PRIVATE_PATHS"));
  assert.ok(robots.includes('"/api/"'));
});

test("canonical sitemaps contain search-result pages, not AI utility files", () => {
  const routes = read("src/lib/siteRoutes.ts");
  const sitemap = read("src/app/sitemap.ts");
  const index = read("src/app/sitemap-index.xml/route.ts");

  for (const utilityPath of ["/llms.txt", "/llms-full.txt", "/ai.txt"]) {
    assert.equal(
      routes.includes(`path: \"${utilityPath}\"`),
      false,
      `${utilityPath} must not be a canonical sitemap entry`,
    );
  }

  assert.ok(routes.includes("getDocumentationCatalog"));
  assert.ok(routes.includes("page.lastModified"));
  assert.ok(routes.includes("latestReleaseUpdate"));
  assert.ok(sitemap.includes("getStaticSitemapEntries"));
  assert.ok(index.includes("SITEMAP_INDEX_ENTRIES"));
});

test("every docs page emits complete metadata and structured data", () => {
  const page = read("src/app/docs/[[...slug]]/page.tsx");
  const discovery = read("src/lib/discovery.ts");

  assert.ok(page.includes("documentationPageMetadata"));
  assert.ok(page.includes("documentationPageJsonLd"));
  assert.ok(page.includes("breadcrumbJsonLd"));
  assert.ok(page.includes('type="application/ld+json"'));
  assert.ok(page.includes("page.data.lastModified"));

  // Docs index is a website; every other docs page is an article.
  assert.ok(discovery.includes('type: path === "/docs" ? "website" : "article"'));
  assert.ok(discovery.includes('card: "summary_large_image"'));
  assert.ok(discovery.includes('"@type": "TechArticle"'));
  assert.ok(discovery.includes("mainEntityOfPage"));
  assert.ok(discovery.includes("dateModified"));
});
