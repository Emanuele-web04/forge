import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(ROOT, relativePath), "utf8");
}

/**
 * Copy assertions are about the words, not where the formatter chose to wrap
 * them. The repo formats JSX at a different width than this site used
 * standalone, so a phrase can span source lines; collapse whitespace before
 * matching so reflowing a paragraph never fails a copy test.
 */
function readFlat(relativePath) {
  return read(relativePath).replace(/\s+/g, " ");
}

function exportedString(source, name) {
  const match = new RegExp(`export const ${name} =\\s*\"([^\"]+)\";`).exec(source);
  assert.ok(match, `${name} is not a direct string export`);
  return match[1];
}

const PUBLIC_COPY_FILES = [
  "src/app/page.tsx",
  "src/app/install/page.tsx",
  "src/components/ClosingCTA.tsx",
  "src/components/FAQ.tsx",
  "src/components/Features.tsx",
  "src/components/MultiProjectShowcase.tsx",
  "src/components/PrivacySection.tsx",
  "src/components/Testimonials.tsx",
  "src/components/Workflow.tsx",
  "src/data/faqs.ts",
  "src/data/product.ts",
  "src/lib/seo.ts",
  "src/lib/llmText.ts",
];

test("canonical product language is centralized and consumed by every discovery layer", () => {
  const product = read("src/data/product.ts");
  const homepage = read("src/app/page.tsx");
  const seo = read("src/lib/seo.ts");
  const llmText = read("src/lib/llmText.ts");
  const faq = read("src/data/faqs.ts");
  const closing = read("src/components/ClosingCTA.tsx");

  assert.equal(
    exportedString(product, "PRODUCT_HERO_TITLE"),
    "Run every coding agent in one workspace",
  );
  assert.ok(exportedString(product, "PRODUCT_HERO_DESCRIPTION").length >= 100);
  assert.ok(exportedString(product, "PRODUCT_DESCRIPTION").length >= 220);
  assert.ok(exportedString(product, "PRODUCT_CATEGORY").length >= 45);

  const metaDescription = exportedString(product, "PRODUCT_META_DESCRIPTION");
  assert.ok(metaDescription.length >= 140, "metadata description is too thin");
  assert.ok(metaDescription.length <= 190, "metadata description is too long");

  assert.ok(product.includes("SUPPORTED_PROVIDERS"));
  assert.ok(product.includes("PRODUCT_PILLARS"));

  for (const [name, source] of [
    ["homepage", homepage],
    ["SEO", seo],
    ["AI discovery", llmText],
    ["FAQ", faq],
    ["closing CTA", closing],
  ]) {
    assert.match(source, /@\/data\/product/, `${name} does not consume canonical product data`);
  }

  assert.ok(seo.includes("SITE_DESCRIPTION = PRODUCT_META_DESCRIPTION"));
});

test("homepage hierarchy keeps one thesis, one proof image, and a coherent action block", () => {
  const homepage = read("src/app/page.tsx");

  assert.ok(homepage.includes("PRODUCT_HERO_TITLE"));
  assert.ok(homepage.includes("PRODUCT_HERO_DESCRIPTION"));
  assert.ok(homepage.includes("data-home-actions"));
  assert.ok(homepage.includes("data-hero-preview"));
  assert.ok(homepage.includes("Star on GitHub"));
  assert.ok(homepage.includes("HomepageRail"));

  for (const removedHeroLabel of [
    "SUPPORTED CODING-AGENT RUNTIMES",
    "09 supported",
    "LOCAL WORKSPACE",
    "task / environment / evidence",
    "ONE TASK / ONE ENVIRONMENT",
    "DIFF · CHECKS · PULL REQUEST",
  ]) {
    assert.equal(
      homepage.toUpperCase().includes(removedHeroLabel),
      false,
      `dense hero label remains: ${removedHeroLabel}`,
    );
  }

  assert.equal(homepage.includes("ProviderMarkRow"), false);
  assert.equal(homepage.includes("ControlPlanePath"), false);
  assert.ok(
    homepage.includes("AskAISection"),
    "AskAISection must be rendered (upstream homepage feature, restored)",
  );
});

test("provider cards use stable runtime capabilities instead of volatile model marketing", () => {
  const features = read("src/components/Features.tsx");

  for (const provider of [
    "Claude Code",
    "Codex",
    "OpenCode",
    "Cursor",
    "Antigravity",
    "Grok Build",
    "Devin CLI",
    "Pi",
    "Factory Droid",
  ]) {
    assert.ok(features.includes(`name: \"${provider}\"`), `missing provider card for ${provider}`);
  }

  for (const volatileLabel of ["Opus 4.8", "GPT-5.5", "Composer 2.5", "500+ models", "Zen + Go"]) {
    assert.equal(
      features.includes(volatileLabel),
      false,
      `volatile label remains: ${volatileLabel}`,
    );
  }

  for (const stableLabel of [
    "CLI + account",
    "Configured models",
    "Agent CLI",
    "agy CLI",
    "grok CLI",
    "ACP + account",
    "Model registry",
    "droid CLI",
  ]) {
    assert.ok(features.includes(stableLabel), `stable capability label is missing: ${stableLabel}`);
  }
});

test("public homepage copy avoids defensive identity and repetitive positioning", () => {
  const combined = PUBLIC_COPY_FILES.map(readFlat).join("\n");

  for (const phrase of [
    "operating system for agentic work",
    ["no longer just a ", "t", "3", " code fork"].join(""),
    "The command center for agentic development",
  ]) {
    assert.equal(
      combined.toLowerCase().includes(phrase.toLowerCase()),
      false,
      `retired phrase remains: ${phrase}`,
    );
  }

  assert.ok(
    existsSync(path.join(ROOT, "src/components/AskAISection.tsx")),
    "AskAISection.tsx must exist (upstream homepage feature, restored)",
  );
});

test("privacy copy states both the local workspace boundary and provider boundary", () => {
  const privacy = readFlat("src/components/PrivacySection.tsx");

  for (const marker of [
    "Workspace state stays on your machine",
    "Provider traffic goes to the selected provider",
    "No Synara account is required",
    "Anonymous analytics are opt-in",
    "provider sessions receive the context",
  ]) {
    assert.ok(privacy.includes(marker), `privacy boundary is missing: ${marker}`);
  }
});

test("testimonial curation excludes identity-defense and volatile-version framing", () => {
  const testimonials = read("src/components/Testimonials.tsx");
  const excludedIds = ["2071916101924262377", "2065178684537888877"];

  for (const id of excludedIds) {
    assert.ok(testimonials.includes(`\"${id}\"`), `testimonial exclusion is missing ${id}`);
  }
  assert.ok(testimonials.includes("EXCLUDED_TESTIMONIAL_IDS"));
  assert.match(testimonials, /filter\([\s\S]*EXCLUDED_TESTIMONIAL_IDS\.has\(card\.id\)/);
});

test("install and metadata surfaces share the new category", () => {
  const install = read("src/app/install/page.tsx");
  const seo = read("src/lib/seo.ts");

  assert.ok(install.includes("PRODUCT_CATEGORY"));
  assert.ok(install.includes("Download Synara — Coding Agent Workspace"));
  assert.ok(seo.includes("PRODUCT_HERO_TITLE"));
  assert.ok(seo.includes("PRODUCT_META_DESCRIPTION"));
  assert.ok(seo.includes("Coding agent workspace and control plane"));
});

test("browser quality mode freezes server-side GitHub data without changing production behavior", () => {
  const installerCount = read("src/lib/installerCount.ts");
  const releases = read("src/lib/releases.ts");
  const stars = read("src/lib/githubStars.ts");

  for (const [name, source] of [
    ["installer count", installerCount],
    ["release downloads", releases],
    ["GitHub stars", stars],
  ]) {
    assert.ok(
      source.includes('process.env.VISUAL_TEST === "1"'),
      `${name} does not honor deterministic browser quality mode`,
    );
  }

  assert.ok(installerCount.includes("return getStoredInstallerCount()"));
});
