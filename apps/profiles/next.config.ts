import type { NextConfig } from "next";

// Two deployment shapes share this app:
// - production: trysynara.com stays on the marketing project, which rewrites
//   /@:handle here — this app never sees the domain root.
// - dev (synara.vrbty.dev): this project owns the domain; src/middleware.ts
//   proxies every non-profile path to MARKETING_ORIGIN.
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
