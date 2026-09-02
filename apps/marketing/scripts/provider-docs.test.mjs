import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { extractInternalLinks, parseFrontmatter } from "./check-docs.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "content", "docs");
const PROVIDERS_DIR = path.join(DOCS_DIR, "providers");

const PROVIDERS = [
  {
    slug: "claude-code",
    title: "Claude Code",
    executable: "claude",
    authMarker: "claude auth status",
    officialDomain: "docs.anthropic.com",
  },
  {
    slug: "codex",
    title: "Codex",
    executable: "codex",
    authMarker: "codex login",
    officialDomain: "developers.openai.com",
  },
  {
    slug: "opencode",
    title: "OpenCode",
    executable: "opencode",
    authMarker: "/connect",
    officialDomain: "opencode.ai",
  },
  {
    slug: "cursor",
    title: "Cursor",
    executable: "cursor-agent",
    authMarker: "cursor-agent login",
    officialDomain: "cursor.com",
  },
  {
    slug: "antigravity",
    title: "Antigravity",
    executable: "agy",
    authMarker: "keyring",
    officialDomain: "antigravity.google",
  },
  {
    slug: "grok",
    title: "Grok Build",
    executable: "grok",
    authMarker: "XAI_API_KEY",
    officialDomain: "docs.x.ai",
  },
  {
    slug: "devin",
    title: "Devin CLI",
    executable: "devin",
    authMarker: "devin auth login",
    officialDomain: "docs.devin.ai",
  },
  {
    slug: "pi",
    title: "Pi",
    executable: "pi",
    authMarker: "/login",
    officialDomain: "github.com/earendil-works/pi",
  },
  {
    slug: "factory-droid",
    title: "Factory Droid",
    executable: "droid",
    authMarker: "FACTORY_API_KEY",
    officialDomain: "docs.factory.ai",
  },
];

const REQUIRED_SECTIONS = [
  "Install",
  "Authenticate",
  "Verify",
  "Connect to Synara",
  "Capabilities in Synara",
  "Troubleshooting",
  "Official documentation",
];

function readProvider(slug) {
  return readFileSync(path.join(PROVIDERS_DIR, `${slug}.mdx`), "utf8");
}

function officialDocumentationSection(source) {
  const heading = "## Official documentation\n";
  const start = source.indexOf(heading);
  if (start === -1) return "";

  const contentStart = start + heading.length;
  const nextHeading = source.indexOf("\n## ", contentStart);
  return source.slice(contentStart, nextHeading === -1 ? source.length : nextHeading);
}

test("root documentation navigation places Providers between Getting started and Workflows", () => {
  const meta = JSON.parse(readFileSync(path.join(DOCS_DIR, "meta.json"), "utf8"));
  const expectedSequence = [
    "---Getting started---",
    "getting-started",
    "---Providers---",
    "providers",
    "---Workflows---",
    "workflows",
  ];
  const start = meta.pages.indexOf(expectedSequence[0]);
  assert.notEqual(start, -1, "root documentation navigation is missing Getting started");
  assert.deepEqual(meta.pages.slice(start, start + expectedSequence.length), expectedSequence);
});

test("provider navigation has the exact supported provider set and order", () => {
  const meta = JSON.parse(readFileSync(path.join(PROVIDERS_DIR, "meta.json"), "utf8"));
  assert.deepEqual(meta.pages, ["index", ...PROVIDERS.map(({ slug }) => slug)]);
  assert.equal(
    new Set(meta.pages).size,
    meta.pages.length,
    "provider navigation contains duplicates",
  );
});

test("every supported provider has a guide with the shared documentation contract", () => {
  for (const provider of PROVIDERS) {
    const file = path.join(PROVIDERS_DIR, `${provider.slug}.mdx`);
    assert.equal(existsSync(file), true, `${provider.slug} guide is missing`);

    const source = readProvider(provider.slug);
    const frontmatter = parseFrontmatter(source);
    assert.equal(frontmatter.error, undefined, `${provider.slug} has invalid frontmatter`);
    assert.equal(frontmatter.values.title, provider.title, `${provider.slug} has the wrong title`);
    assert.ok(frontmatter.values.description?.trim(), `${provider.slug} needs a description`);

    for (const section of REQUIRED_SECTIONS) {
      assert.match(
        source,
        new RegExp(`^## ${section}$`, "m"),
        `${provider.slug} is missing “${section}”`,
      );
    }

    assert.match(
      source,
      new RegExp(`\\b${provider.executable.replaceAll("-", "\\-")}\\b`),
      `${provider.slug} does not name its executable`,
    );
    assert.ok(
      source.includes(provider.authMarker),
      `${provider.slug} does not document its authentication marker`,
    );

    const officialSources = officialDocumentationSection(source);
    assert.match(
      officialSources,
      new RegExp(`https://${provider.officialDomain.replaceAll(".", "\\.")}`),
      `${provider.slug} does not cite its expected official domain`,
    );
    assert.doesNotMatch(
      officialSources,
      /\]\(http:\/\//,
      `${provider.slug} contains an insecure official documentation URL`,
    );
  }
});

test("the provider index links to every guide", () => {
  const source = readFileSync(path.join(PROVIDERS_DIR, "index.mdx"), "utf8");
  const links = extractInternalLinks(source);

  for (const { slug } of PROVIDERS) {
    const route = `/docs/providers/${slug}`;
    assert.ok(links.includes(route), `provider index does not link to ${route}`);
  }
});

test("the provider index names every provider and executable", () => {
  const source = readFileSync(path.join(PROVIDERS_DIR, "index.mdx"), "utf8");
  for (const provider of PROVIDERS) {
    assert.ok(source.includes(provider.title), `provider index does not name ${provider.title}`);
    assert.ok(
      source.includes(`\`${provider.executable}\``),
      `provider index does not show ${provider.executable}`,
    );
  }
});

test("the Getting Started provider page points readers to the dedicated provider section", () => {
  const source = readFileSync(path.join(DOCS_DIR, "getting-started", "providers.mdx"), "utf8");
  assert.ok(
    source.includes("/docs/providers"),
    "Getting Started providers page must link to the dedicated provider guides",
  );
});
