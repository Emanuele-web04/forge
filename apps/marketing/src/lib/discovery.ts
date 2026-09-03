import type { Metadata } from "next";

import {
  absoluteUrl,
  OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
  X_PROFILE_URL,
} from "@/lib/seo";

/** Search and user-directed retrieval agents that affect answer visibility. */
export const AI_DISCOVERY_USER_AGENTS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
] as const;

/** General web-search crawlers that can also feed AI-assisted search products. */
export const SEARCH_USER_AGENTS = ["Googlebot", "Bingbot", "Applebot"] as const;

/**
 * Model-development controls are intentionally separate from search/retrieval.
 * Allowing or blocking these is a publishing-policy choice, not an SEO switch.
 */
export const AI_TRAINING_USER_AGENTS = ["GPTBot", "ClaudeBot", "Google-Extended"] as const;

export const AI_DISCOVERY_PATHS = ["/llms.txt", "/llms-full.txt", "/ai.txt"] as const;

const X_HANDLE = `@${new URL(X_PROFILE_URL).pathname.replace(/^\//, "")}`;

function toIsoDate(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

export function documentationPageMetadata({
  title,
  description,
  path,
}: {
  title: string;
  description: string;
  path: string;
}): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      type: path === "/docs" ? "website" : "article",
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
      creator: X_HANDLE,
      images: [OG_IMAGE],
    },
  };
}

export function documentationPageJsonLd({
  title,
  description,
  path,
  lastModified,
}: {
  title: string;
  description: string;
  path: string;
  lastModified?: Date | string | null;
}) {
  const modified = toIsoDate(lastModified);
  const url = absoluteUrl(path);

  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "@id": `${url}#article`,
    headline: title,
    name: title,
    description,
    url,
    mainEntityOfPage: url,
    inLanguage: "en-US",
    ...(modified ? { dateModified: modified } : {}),
    author: { "@id": `${SITE_URL}/#organization` },
    publisher: { "@id": `${SITE_URL}/#organization` },
    about: { "@id": `${SITE_URL}/#app` },
    isPartOf: { "@id": `${SITE_URL}/#website` },
  };
}

export const AI_DISCOVERY_NOTICE =
  "These plain-text files are convenience indexes for agents and answer engines. robots.txt and page-level indexing directives remain authoritative.";

export const CANONICAL_PRODUCT_FACT = SITE_DESCRIPTION;
