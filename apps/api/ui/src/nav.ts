// FILE: ui/src/nav.ts
// Purpose: Rules for carrying ceremony intent (device approval, desktop deep
// link) across a sign-in that may bounce through an external OAuth provider.
// Layer: Account UI routing
// Depends on: nothing.

// Params that describe *why* the user is signing in. They are threaded through
// the social redirect via `callbackURL`, since that is the only state we
// control across the provider round-trip.
const CARRIED_PARAMS = ["redirect", "user_code", "deep_link"] as const;

export function carriedParams(search: string): URLSearchParams {
  const from = new URLSearchParams(search);
  const carried = new URLSearchParams();
  for (const key of CARRIED_PARAMS) {
    const value = from.get(key);
    if (value) carried.set(key, value);
  }
  return carried;
}

export function withCarriedParams(path: string, search: string): string {
  const carried = carriedParams(search);
  const query = carried.toString();
  return query ? `${path}?${query}` : path;
}

/** Where a completed sign-in should land, given the intent in the URL. */
export function postAuthTarget(search: string): string {
  const params = new URLSearchParams(search);
  if (params.get("redirect") === "device") {
    const userCode = params.get("user_code");
    return userCode ? `/device?user_code=${encodeURIComponent(userCode)}` : "/device";
  }
  return withCarriedParams("/callback", search);
}

/** The `synara://` URL a desktop-initiated sign-in hands back to the app. */
export function deepLinkUrl(search: string): string | undefined {
  const params = new URLSearchParams(search);
  if (params.get("deep_link") !== "synara") return undefined;
  const forwarded = new URLSearchParams();
  for (const [key, value] of params) {
    if (key !== "deep_link") forwarded.set(key, value);
  }
  const query = forwarded.toString();
  return query ? `synara://auth/callback?${query}` : "synara://auth/callback";
}
