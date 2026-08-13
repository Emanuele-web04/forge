// FILE: robots.ts
// Purpose: Generates /robots.txt for search, AI discovery, and sitemap hints.
// Layer: Next.js metadata route.

import type { MetadataRoute } from "next";
import {
  AI_DISCOVERY_PATHS,
  AI_DISCOVERY_USER_AGENTS,
  AI_TRAINING_USER_AGENTS,
  SEARCH_USER_AGENTS,
} from "@/lib/discovery";
import { SITE_URL, absoluteUrl } from "@/lib/seo";
import { SITEMAP_PATHS } from "@/lib/siteRoutes";

const PUBLIC_ALLOW_PATHS = ["/", ...AI_DISCOVERY_PATHS];
const PRIVATE_PATHS = ["/api/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: PUBLIC_ALLOW_PATHS,
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: [...SEARCH_USER_AGENTS],
        allow: PUBLIC_ALLOW_PATHS,
        disallow: PRIVATE_PATHS,
      },
      {
        userAgent: [...AI_DISCOVERY_USER_AGENTS],
        allow: PUBLIC_ALLOW_PATHS,
        disallow: PRIVATE_PATHS,
      },
      {
        // Training controls are explicit so they are not mistaken for search visibility controls.
        userAgent: [...AI_TRAINING_USER_AGENTS],
        allow: PUBLIC_ALLOW_PATHS,
        disallow: PRIVATE_PATHS,
      },
    ],
    sitemap: [absoluteUrl("/sitemap-index.xml"), ...SITEMAP_PATHS.map(absoluteUrl)],
    host: SITE_URL,
  };
}
