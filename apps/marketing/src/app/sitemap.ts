// FILE: sitemap.ts
// Purpose: Generates /sitemap.xml for canonical static pages and AI text files.
// Layer: Next.js metadata route.

import type { MetadataRoute } from "next";
import { getStaticSitemapEntries } from "@/lib/siteRoutes";

export default function sitemap(): MetadataRoute.Sitemap {
  return getStaticSitemapEntries();
}
