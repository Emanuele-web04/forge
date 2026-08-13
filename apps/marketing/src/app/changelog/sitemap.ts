// FILE: changelog/sitemap.ts
// Purpose: Generates /changelog/sitemap.xml with one canonical URL per release.
// Layer: Next.js metadata route.

import type { MetadataRoute } from "next";
import { getChangelogSitemapEntries } from "@/lib/siteRoutes";

export default function sitemap(): MetadataRoute.Sitemap {
  return getChangelogSitemapEntries();
}
