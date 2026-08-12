import type { NextConfig } from "next";

// Two deployment shapes share this config:
// - production: trysynara.com stays on the marketing project, which rewrites
//   /@:handle here — this app never sees the domain root.
// - dev (synara.vrbty.dev): THIS project owns the domain, so everything that
//   is not a profile path is rewritten out to the marketing deployment. The
//   rewrite only mounts when MARKETING_ORIGIN is set, so production stays
//   exactly as documented above.
const marketingOrigin = process.env.MARKETING_ORIGIN;

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(marketingOrigin
    ? {
        async rewrites() {
          return {
            beforeFiles: [],
            afterFiles: [],
            // Only paths no route matched: profiles keep resolving here,
            // everything else (/, /install, /download, assets) proxies to
            // the marketing site.
            fallback: [{ source: "/:path*", destination: `${marketingOrigin}/:path*` }],
          };
        },
      }
    : {}),
};

export default nextConfig;
