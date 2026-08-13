// FILE: lib/siteRoutes.ts
// Purpose: Defines canonical crawl targets shared by sitemap routes.
// Layer: server utility.

import type { MetadataRoute } from "next";
import { getSortedReleases, toVersionSlug } from "@/lib/changelog";
import { getDocumentationCatalog } from "@/lib/docs";
import {
  DOCS_LAST_UPDATED,
  PRIVACY_LAST_UPDATED,
  releaseDate,
  SITE_LATEST_UPDATE,
  SPONSOR_LAST_UPDATED,
} from "@/lib/releaseDates";
import { absoluteUrl, SITE_IMAGES } from "@/lib/seo";

export const SITEMAP_PATHS = ["/sitemap.xml", "/changelog/sitemap.xml"] as const;

const releases = getSortedReleases();
const latestReleaseUpdate = releases[0] ? releaseDate(releases[0].date) : SITE_LATEST_UPDATE;
const documentationCatalog = getDocumentationCatalog();

function normalizedDate(value: Date | string | null, fallback: Date) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

const latestDocumentationUpdate = documentationCatalog.reduce((latest, page) => {
  const candidate = normalizedDate(page.lastModified, DOCS_LAST_UPDATED);
  return candidate > latest ? candidate : latest;
}, DOCS_LAST_UPDATED);

const mainSitemapUpdate =
  latestDocumentationUpdate > latestReleaseUpdate ? latestDocumentationUpdate : latestReleaseUpdate;

export const SITEMAP_INDEX_ENTRIES = [
  { path: "/sitemap.xml", lastModified: mainSitemapUpdate },
  { path: "/changelog/sitemap.xml", lastModified: latestReleaseUpdate },
] as const;

const staticRoutes = [
  {
    path: "/",
    lastModified: latestReleaseUpdate,
    changeFrequency: "daily",
    priority: 1,
    images: [
      absoluteUrl(SITE_IMAGES.og),
      absoluteUrl(SITE_IMAGES.lightScreenshot),
      absoluteUrl(SITE_IMAGES.darkScreenshot),
    ],
  },
  {
    path: "/install",
    lastModified: latestReleaseUpdate,
    changeFrequency: "daily",
    priority: 0.95,
    images: [absoluteUrl(SITE_IMAGES.og)],
  },
  {
    path: "/changelog",
    lastModified: latestReleaseUpdate,
    changeFrequency: "daily",
    priority: 0.8,
    images: [absoluteUrl(SITE_IMAGES.og)],
  },
  {
    path: "/sponsor",
    lastModified: SPONSOR_LAST_UPDATED,
    changeFrequency: "monthly",
    priority: 0.5,
    images: [absoluteUrl(SITE_IMAGES.og)],
  },
  {
    path: "/sponsors",
    lastModified: SPONSOR_LAST_UPDATED,
    changeFrequency: "monthly",
    priority: 0.4,
    images: [absoluteUrl(SITE_IMAGES.og)],
  },
  {
    path: "/privacy",
    lastModified: PRIVACY_LAST_UPDATED,
    changeFrequency: "yearly",
    priority: 0.35,
    images: [absoluteUrl(SITE_IMAGES.og)],
  },
] satisfies Array<Omit<MetadataRoute.Sitemap[number], "url"> & { path: string }>;

function documentationPriority(url: string) {
  if (url === "/docs") return 0.9;
  if (url === "/docs/getting-started/quickstart" || url === "/docs/getting-started/installation") {
    return 0.85;
  }
  if (url.split("/").filter(Boolean).length === 2) return 0.8;
  return 0.7;
}

export function getStaticSitemapEntries(): MetadataRoute.Sitemap {
  return [
    ...staticRoutes.map(({ path, ...entry }) => ({
      ...entry,
      url: absoluteUrl(path),
    })),
    ...documentationCatalog.map((page) => ({
      url: absoluteUrl(page.url),
      lastModified: normalizedDate(page.lastModified, DOCS_LAST_UPDATED),
      changeFrequency: "weekly" as const,
      priority: documentationPriority(page.url),
    })),
  ];
}

export function getChangelogSitemapEntries(): MetadataRoute.Sitemap {
  return releases.map((entry) => ({
    url: absoluteUrl(`/changelog/${toVersionSlug(entry.version)}`),
    lastModified: releaseDate(entry.date),
    changeFrequency: "monthly",
    priority: entry.version.startsWith("0.1.") ? 0.7 : 0.55,
    images: entry.heroImage ? [absoluteUrl(entry.heroImage)] : [absoluteUrl(SITE_IMAGES.og)],
  }));
}
