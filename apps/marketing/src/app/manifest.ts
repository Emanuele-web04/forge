// FILE: manifest.ts
// Purpose: Generates the web app manifest with Synara identity, icons, and screenshots.
// Layer: Next.js metadata route.

import type { MetadataRoute } from "next";
import { SITE_DESCRIPTION, SITE_NAME, SITE_IMAGES } from "@/lib/seo";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: `${SITE_NAME} — Run every coding agent in one workspace`,
    short_name: SITE_NAME,
    description: SITE_DESCRIPTION,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#111111",
    categories: ["developer", "productivity", "utilities"],
    icons: [
      {
        src: SITE_IMAGES.icon,
        sizes: "2048x2048",
        type: "image/png",
        purpose: "any",
      },
      {
        src: SITE_IMAGES.icon,
        sizes: "2048x2048",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/icon.png",
        sizes: "256x256",
        type: "image/png",
      },
      {
        src: "/apple-icon.png",
        sizes: "180x180",
        type: "image/png",
      },
    ],
    screenshots: [
      {
        src: SITE_IMAGES.lightScreenshot,
        sizes: "3216x2090",
        type: "image/png",
        form_factor: "wide",
        label: "Synara desktop workspace in light mode",
      },
      {
        src: SITE_IMAGES.darkScreenshot,
        sizes: "3228x2102",
        type: "image/png",
        form_factor: "wide",
        label: "Synara desktop workspace in dark mode",
      },
    ],
  };
}
