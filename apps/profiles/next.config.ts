import type { NextConfig } from "next";

// Two deployment shapes share this app:
// - production: trysynara.com stays on the marketing project, which rewrites
//   /@:handle here — this app never sees the domain root. Only the DOCUMENT
//   is proxied, so root-relative /_next/static asset URLs would resolve
//   against the marketing deployment and 404; PROFILES_ASSET_PREFIX (e.g.
//   https://trysynara.com/profiles-assets, paired with a /profiles-assets/*
//   rewrite in the marketing project's vercel.json) routes them back here.
// - dev (synara.vrbty.dev): this project owns the domain; src/middleware.ts
//   proxies every non-profile path to MARKETING_ORIGIN and resolves /_next
//   local-first. PROFILES_ASSET_PREFIX stays unset there — assets remain
//   root-relative and nothing changes.
const assetPrefix = process.env.PROFILES_ASSET_PREFIX;
const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(assetPrefix ? { assetPrefix } : {}),
};

export default nextConfig;
