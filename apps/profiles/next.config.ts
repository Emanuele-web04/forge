import type { NextConfig } from "next";

// Served behind the trysynara.com rewrite (`/@:handle` → this app), so
// nothing here may assume it owns the domain root: every route is a profile.
const nextConfig: NextConfig = {
  poweredByHeader: false,
};

export default nextConfig;
