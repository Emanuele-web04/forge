// The public-profile read, kept dependency-free: this app deploys to Vercel
// on its own and deliberately does not import the Effect-based contracts
// packages — the response shape below mirrors `PublicProfile` in
// packages/contracts/src/accountUsage.ts, which is the canonical definition.

import { headers } from "next/headers";

export const ACCOUNT_API_URL = process.env.ACCOUNT_API_URL ?? "https://api.synara.vrbty.dev";

export type PublicProfileModelUsage = {
  provider: string;
  model: string;
  reasoning: string | null;
  tokens: number;
  turns: number;
  prompts: number;
};

export type PublicProfileHeatmapDay = {
  day: string;
  tokens: number;
  prompts: number;
};

export type PublicProfile = {
  handle: string;
  displayName: string;
  avatarColor: string;
  /**
   * The resolved avatar image URL (uploaded object or cached sso picture),
   * or null when the owner chose the initials placeholder. Optional so the
   * page keeps rendering against a pre-avatar API.
   */
  avatarUrl?: string | null;
  createdAt: string;
  lifetimeTokens: number;
  lifetimePrompts: number;
  lifetimeTurns: number;
  models: PublicProfileModelUsage[];
  heatmap: PublicProfileHeatmapDay[];
  peakDay: { day: string; tokens: number } | null;
  hours: { hour: number; prompts: number }[];
  currentStreakDays: number;
  longestStreakDays: number;
};

/** An IPv4/IPv6-shaped string, bounded — the value came off a request header. */
function looksLikeIp(value: string): boolean {
  return value.length <= 45 && /^[0-9A-Fa-f:.]+$/.test(value);
}

/**
 * The visiting browser's IP, read off the incoming request. Every profile
 * fetch runs server-side, so without this the account API would see one
 * caller — this app's egress IP — and its per-IP public-profile budget would
 * throttle all visitors collectively. Forwarded as `x-synara-viewer-ip` so
 * the API can key its rate limit on the actual viewer; rate-limit keying
 * only, never authentication.
 */
async function viewerIp(): Promise<string | null> {
  let incoming: Awaited<ReturnType<typeof headers>>;
  try {
    // Throws outside a request scope (e.g. build-time prerender): no viewer.
    incoming = await headers();
  } catch {
    return null;
  }
  const forwardedFor = incoming.get("x-forwarded-for");
  const firstHop = forwardedFor?.split(",")[0]?.trim();
  const candidate = firstHop || incoming.get("x-real-ip")?.trim();
  return candidate && looksLikeIp(candidate) ? candidate : null;
}

/**
 * The profile behind a handle, or null for "not published" — a 404 covers
 * both an unknown handle and a private profile, indistinguishable by design.
 * Any other failure throws, so an API outage renders as an error page rather
 * than a convincing-looking "no such profile".
 */
export async function fetchPublicProfile(handle: string): Promise<PublicProfile | null> {
  const ip = await viewerIp();
  const response = await fetch(`${ACCOUNT_API_URL}/api/v1/profiles/${encodeURIComponent(handle)}`, {
    ...(ip ? { headers: { "x-synara-viewer-ip": ip } } : {}),
    // Freshness over caching, but not per-request: usage pushes land every
    // few seconds, and a minute-stale profile is indistinguishable to a
    // visitor while keeping the API out of every page load.
    next: { revalidate: 15 },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Profile request failed with ${response.status}`);
  return (await response.json()) as PublicProfile;
}
