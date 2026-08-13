// FILE: route.ts
// Purpose: Exposes the live installer total to the client as a CDN-cached JSON response.
// Layer: App Router route handler
// Depends on: getInstallerCount server utility

import { NextResponse } from "next/server";

import { getInstallerCount } from "@/lib/installerCount";

// COST FIX (Vercel audit): the homepage mounts InstallerCount twice (hero + closing CTA),
// each polling this route every 30s. With force-dynamic + no-store every poll ran a
// function invocation + GitHub API call. Caching the route for 60s makes the polls
// free CDN cache hits; the GitHub fetch now runs at most once per 60s per PoP.
export const revalidate = 60;

// Returns the current installer total so the homepage can refresh it while open.
export async function GET() {
  const count = await getInstallerCount();

  if (count === null) {
    return NextResponse.json(
      { error: "Unable to fetch installer count." },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store, max-age=0",
        },
      },
    );
  }

  return NextResponse.json(
    { count },
    {
      headers: {
        "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    },
  );
}
