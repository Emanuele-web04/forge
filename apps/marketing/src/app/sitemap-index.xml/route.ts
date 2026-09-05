// FILE: sitemap-index.xml/route.ts
// Purpose: Serves a sitemap index so crawlers can discover every sitemap.
// Layer: App Router route handler.

import { SITEMAP_INDEX_ENTRIES } from "@/lib/siteRoutes";
import { absoluteUrl } from "@/lib/seo";

export const revalidate = 86400;

export function GET() {
  const entries = SITEMAP_INDEX_ENTRIES.map(
    ({ path, lastModified }) =>
      `  <sitemap><loc>${absoluteUrl(path)}</loc><lastmod>${lastModified.toISOString()}</lastmod></sitemap>`,
  ).join("\n");

  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`,
    {
      headers: {
        "Content-Type": "application/xml; charset=utf-8",
        "Cache-Control": "public, max-age=3600, s-maxage=86400",
      },
    },
  );
}
