// FILE: lib/seo.ts
// Purpose: Single source of truth for crawlable metadata, canonical URLs,
//          JSON-LD builders, crawler allow-lists, and page metadata helpers.
// Layer: shared metadata (server-importable).
// Note: Page-level `openGraph` replaces the layout's shallow-merged field, so
//       `pageMetadata` re-adds the global image anywhere a route customizes SEO.

import type { Metadata } from "next";
import { FAQ_ITEMS } from "@/data/faqs";
import { type ChangelogEntry } from "@/data/changelog";
import {
  PRODUCT_CATEGORY,
  PRODUCT_META_DESCRIPTION,
  PRODUCT_NAME,
  SUPPORTED_PROVIDERS,
} from "@/data/product";
import { releaseDateIso } from "@/lib/releaseDates";

/** Canonical production origin; keep aligned with Vercel's primary domain. */
export const SITE_URL = "https://www.trysynara.com";

export const SITE_NAME = PRODUCT_NAME;

export const CREATOR_NAME = "Emanuele Di Pietro";
export const CREATOR_URL = "https://emanueledipietro.com";
export const GITHUB_REPO_URL = "https://github.com/Emanuele-web04/synara";
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`;
export const GITHUB_SPONSORS_URL = "https://github.com/sponsors/Emanuele-web04";
export const X_PROFILE_URL = "https://x.com/emanueledpt";
export const YOUTUBE_URL = "https://youtube.com/@emanueledpt";

/**
 * Search/share title — brand first, then the high-intent provider keywords.
 * Kept deliberately separate from `PRODUCT_HERO_TITLE`: the on-page H1 sells the
 * outcome, while this title has to win the SERP/share-card keyword match.
 */
export const SITE_TITLE = `${SITE_NAME} — AI Coding Workspace for Claude Code, Codex & Cursor`;

/** Concise search/share description. The full definition lives in product.ts. */
export const SITE_DESCRIPTION = PRODUCT_META_DESCRIPTION;

export const SEO_KEYWORDS = [
  "Synara",
  "AI coding agents",
  "coding agent workspace",
  "local-first coding workspace",
  "multi-agent development",
  "coding agent control plane",
  "parallel coding agents",
  "Claude Code workspace",
  "Codex workspace",
  "OpenCode GUI",
  "Cursor agent workspace",
  "Antigravity CLI GUI",
  "Grok Build",
  "Devin CLI workspace",
  "Pi coding agent",
  "Factory Droid",
  "Git worktrees",
  "agent browser verification",
  "developer tools",
  "open source AI coding app",
];

export const AI_SEARCH_USER_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "GPTBot",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Google-Extended",
  "Applebot",
  "Bingbot",
] as const;

/** The official 1200×600 share image, served from public/og.png. */
export const OG_IMAGE = {
  url: "/og.png",
  width: 1200,
  height: 600,
  alt: `${SITE_NAME} — ${PRODUCT_CATEGORY}`,
};

export const SITE_IMAGES = {
  icon: "/synara-icon.png",
  og: "/og.png",
  lightScreenshot: "/synara-ui-light.png",
  darkScreenshot: "/synara-ui-dark.png",
};

/** Builds an absolute production URL for metadata, sitemaps, and structured data. */
export function absoluteUrl(path = "/") {
  return new URL(path, SITE_URL).toString();
}

/**
 * Serializes JSON-LD for a native script tag and escapes `<` as recommended by
 * the Next.js JSON-LD guide so structured data cannot break out of the script.
 */
export function jsonLdScript(value: unknown) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * schema.org structured data (Organization + WebSite + SoftwareApplication).
 * Rendered once in the root layout so it applies to every route.
 */
export const SITE_JSONLD = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${SITE_URL}/#organization`,
      name: SITE_NAME,
      legalName: SITE_NAME,
      url: SITE_URL,
      logo: absoluteUrl(SITE_IMAGES.icon),
      image: absoluteUrl(SITE_IMAGES.og),
      founder: {
        "@type": "Person",
        name: CREATOR_NAME,
        url: CREATOR_URL,
        sameAs: [X_PROFILE_URL, YOUTUBE_URL],
      },
      sameAs: [GITHUB_REPO_URL, X_PROFILE_URL, YOUTUBE_URL, CREATOR_URL],
    },
    {
      "@type": "WebSite",
      "@id": `${SITE_URL}/#website`,
      name: SITE_NAME,
      url: SITE_URL,
      description: SITE_DESCRIPTION,
      publisher: { "@id": `${SITE_URL}/#organization` },
      inLanguage: "en-US",
      keywords: SEO_KEYWORDS.join(", "),
    },
    {
      "@type": "SoftwareApplication",
      "@id": `${SITE_URL}/#app`,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
      url: SITE_URL,
      image: absoluteUrl(SITE_IMAGES.og),
      screenshot: [
        absoluteUrl(SITE_IMAGES.lightScreenshot),
        absoluteUrl(SITE_IMAGES.darkScreenshot),
      ],
      downloadUrl: absoluteUrl("/install"),
      sameAs: GITHUB_REPO_URL,
      operatingSystem: "macOS, Windows, Linux",
      applicationCategory: "DeveloperApplication",
      applicationSubCategory: "Coding agent workspace and control plane",
      isAccessibleForFree: true,
      license: "https://opensource.org/licenses/MIT",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": `${SITE_URL}/#organization` },
      featureList: [
        `Run ${SUPPORTED_PROVIDERS.join(", ")} from one desktop workspace`,
        "Keep each task attached to its provider session, working directory, terminal, browser, diff, and delivery state",
        "Use isolated Git worktrees for parallel agent tasks",
        "Hand work between supported providers without changing the task environment",
        "Verify results with commands, browser evidence, diffs, checks, commits, and pull requests",
        "Keep workspace state local while selected providers receive the context required for their sessions",
      ],
    },
  ],
};

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absoluteUrl(item.path),
    })),
  };
}

export const FAQ_JSONLD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map(({ question, answer }) => ({
    "@type": "Question",
    name: question,
    acceptedAnswer: {
      "@type": "Answer",
      text: answer,
    },
  })),
};

export const INSTALL_JSONLD = {
  "@context": "https://schema.org",
  "@type": "WebPage",
  "@id": `${SITE_URL}/install#webpage`,
  name: "Download Synara",
  url: absoluteUrl("/install"),
  description: `Download ${SITE_NAME} for macOS, Windows, and Linux — ${PRODUCT_CATEGORY}`,
  isPartOf: { "@id": `${SITE_URL}/#website` },
  about: { "@id": `${SITE_URL}/#app` },
  primaryImageOfPage: absoluteUrl(SITE_IMAGES.og),
  potentialAction: {
    "@type": "DownloadAction",
    target: absoluteUrl("/install"),
    object: { "@id": `${SITE_URL}/#app` },
  },
};

export function changelogCollectionJsonLd(entries: readonly ChangelogEntry[]) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    "@id": `${SITE_URL}/changelog#collection`,
    name: "Synara changelog",
    url: absoluteUrl("/changelog"),
    description:
      "Release notes for Synara, including provider support, coding-agent workflows, reliability, performance, and installer updates.",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#app` },
    mainEntity: {
      "@type": "ItemList",
      itemListElement: entries.map((entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: `Synara ${entry.version}`,
        url: absoluteUrl(`/changelog/v${entry.version}`),
      })),
    },
  };
}

export function releaseJsonLd(entry: ChangelogEntry) {
  const highlights = entry.features.map((feature) => feature.title).join(", ");
  const date = releaseDateIso(entry.date);
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${SITE_URL}/changelog/v${entry.version}#release-notes`,
    headline: `Synara ${entry.version} release notes`,
    name: `Synara ${entry.version} changelog`,
    url: absoluteUrl(`/changelog/v${entry.version}`),
    description: `What's new in Synara ${entry.version}: ${highlights}.`,
    image: absoluteUrl(entry.heroImage ?? SITE_IMAGES.og),
    datePublished: date,
    dateModified: date,
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    about: { "@id": `${SITE_URL}/#app` },
  };
}

/**
 * Sponsorship tiers as an OfferCatalog hanging off the sponsor page, so the
 * prices are machine-readable rather than trapped in the layout.
 */
export function sponsorJsonLd(
  tiers: ReadonlyArray<{ label: string; amount: number; tagline: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/sponsor#webpage`,
    name: "Sponsor Synara",
    url: absoluteUrl("/sponsor"),
    description:
      "Sponsor Synara through GitHub Sponsors. Monthly tiers from $5 to $499 plus custom one-time amounts fund development, releases, and docs for the free, open-source desktop app.",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#app` },
    primaryImageOfPage: absoluteUrl(SITE_IMAGES.og),
    mainEntity: {
      "@type": "OfferCatalog",
      name: "Synara sponsorship tiers",
      itemListElement: tiers.map((tier) => ({
        "@type": "Offer",
        name: tier.label,
        description: tier.tagline,
        price: String(tier.amount),
        priceCurrency: "USD",
        url: GITHUB_SPONSORS_URL,
        priceSpecification: {
          "@type": "UnitPriceSpecification",
          price: tier.amount,
          priceCurrency: "USD",
          billingIncrement: 1,
          unitCode: "MON",
        },
      })),
    },
  };
}

/**
 * The sponsor wall as an ItemList of the people credited on it.
 *
 * Takes an already-resolved `url` per sponsor rather than building a GitHub
 * profile link here: `sponsorLink()` in lib/sponsors owns that choice (it
 * prefers a sponsor's own site over their GitHub profile), and this module
 * can't import it — lib/sponsors imports GITHUB_SPONSORS_URL from here, so
 * reaching back the other way would make the two files circular.
 */
export function sponsorsPageJsonLd(sponsors: ReadonlyArray<{ name: string; url: string }>) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    "@id": `${SITE_URL}/sponsors#webpage`,
    name: "Synara sponsors",
    url: absoluteUrl("/sponsors"),
    description:
      "The people and companies funding Synara, the free and open-source command center for agentic development.",
    isPartOf: { "@id": `${SITE_URL}/#website` },
    about: { "@id": `${SITE_URL}/#app` },
    primaryImageOfPage: absoluteUrl(SITE_IMAGES.og),
    mainEntity: {
      "@type": "ItemList",
      name: "Synara sponsors",
      numberOfItems: sponsors.length,
      itemListElement: sponsors.map((sponsor, index) => ({
        "@type": "ListItem",
        position: index + 1,
        item: {
          "@type": "Person",
          name: sponsor.name,
          url: sponsor.url,
        },
      })),
    },
  };
}

export function pageMetadata({
  title,
  description,
  path = "/",
}: {
  title: string;
  description: string;
  path?: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      url: path,
      title,
      description,
      images: [OG_IMAGE],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      creator: "@emanueledpt",
      images: [OG_IMAGE],
    },
  };
}
