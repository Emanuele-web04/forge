// FILE: WebAnalytics.tsx
// Purpose: Loads Cloudflare Web Analytics when a site token is configured.
// Layer: Server component
// Depends on: CLOUDFLARE_ANALYTICS_TOKEN, VISUAL_TEST

import Script from "next/script";

/**
 * Replaces @vercel/analytics, which only reports from a Vercel deployment and
 * would have loaded but silently collected nothing once the site moved to
 * Workers.
 *
 * Presence of the token is the switch, rather than a platform check: the site
 * gets analytics wherever the token is set (including a Workers preview, if you
 * want traffic data from it) and stays quiet in local dev, tests, and any
 * deployment that has not configured one. VISUAL_TEST forces it off so the
 * screenshot fixture never depends on a third-party script.
 *
 * Cookie-free and collects no personal data, which is what /privacy documents:
 * https://developers.cloudflare.com/web-analytics/
 */
export function WebAnalytics() {
  const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
  if (!token || process.env.VISUAL_TEST === "1") return null;

  return (
    <Script
      // afterInteractive, not beforeInteractive: analytics must never sit on
      // the critical path of a marketing page whose performance is gated.
      strategy="afterInteractive"
      src="https://static.cloudflareinsights.com/beacon.min.js"
      data-cf-beacon={JSON.stringify({ token })}
    />
  );
}
