// FILE: clientIp.ts
// Purpose: Best-effort caller identity for rate limiting.
// Layer: API support
// Depends on: @hono/node-server conninfo (socket address behind no proxy).

import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

/** Injectable for tests; mirrors the two facts `clientIp` reads off a request. */
export type ClientIpSource = {
  forwardedFor: string | undefined;
  remoteAddress: () => string | undefined;
};

/**
 * How many proxies in front of this service are trusted to have appended to
 * `x-forwarded-for`. The default is 0 — trust only the socket address — the
 * one value that is safe for the direct/Docker self-host path, where any
 * nonzero default would let a caller mint fresh rate-limit buckets by
 * rotating a forged header. Proxied deployments opt in explicitly:
 * TRUSTED_PROXY_HOPS=1 for Railway and similar single TLS-terminating
 * proxies (see .env.example).
 */
export const DEFAULT_TRUSTED_PROXY_HOPS = 0;

/**
 * Resolves a rate-limiting key from a request.
 *
 * `x-forwarded-for` is appended to by each proxy on the way in, so only the
 * rightmost `trustedProxyHops` entries were written by infrastructure this
 * service trusts — everything left of them is whatever the client chose to
 * send. With N trusted hops the entry N-from-the-right is the address the
 * outermost trusted proxy saw, i.e. the real caller. The leftmost entry is
 * never used: keying on it would let a caller mint a fresh bucket per request
 * and turn every per-IP budget into no budget at all.
 *
 * With zero trusted hops the header is ignored outright and the socket's
 * remote address is the caller — the no-proxy deployment a self-hoster runs.
 * A header with fewer entries than trusted hops did not traverse the expected
 * proxies, so it degrades to the socket address too. `"unknown"` is a shared
 * bucket of last resort for requests that expose neither.
 */
export function resolveClientIp(source: ClientIpSource, trustedProxyHops: number): string {
  const hops = Number.isInteger(trustedProxyHops) && trustedProxyHops > 0 ? trustedProxyHops : 0;

  if (hops > 0 && source.forwardedFor !== undefined) {
    const entries = source.forwardedFor
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    const candidate = entries[entries.length - hops];
    if (candidate) return candidate;
  }

  const remote = source.remoteAddress()?.trim();
  if (remote) return remote;

  return "unknown";
}

export function clientIp(c: Context, trustedProxyHops: number): string {
  return resolveClientIp(
    {
      forwardedFor: c.req.header("x-forwarded-for"),
      // Reaches into the Node socket, which a synthetic `app.request()` context
      // does not have — a missing address must degrade, not throw.
      remoteAddress: () => {
        try {
          return getConnInfo(c).remote.address;
        } catch {
          return undefined;
        }
      },
    },
    trustedProxyHops,
  );
}

/**
 * The trusted-proxy hop count from the environment. `TRUSTED_PROXY_HOPS`
 * accepts a small non-negative integer; anything else (including absence)
 * yields the safe no-proxy default of {@link DEFAULT_TRUSTED_PROXY_HOPS} —
 * a deployment behind a proxy must set the variable explicitly.
 */
export function resolveTrustedProxyHops(value: string | undefined): number {
  if (value === undefined || value.trim().length === 0) return DEFAULT_TRUSTED_PROXY_HOPS;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== value.trim()) {
    return DEFAULT_TRUSTED_PROXY_HOPS;
  }
  return parsed;
}

/**
 * A client IP fit to forward upstream as risk-control context, or undefined.
 * Allowlist-shaped: only characters that appear in an IPv4/IPv6 literal, and
 * bounded in length — the value originated in a client-controllable header,
 * so anything that does not look like an address is dropped rather than
 * passed along.
 */
export function sanitizeForwardableIp(ip: string): string | undefined {
  if (ip === "unknown") return undefined;
  if (ip.length > 45) return undefined;
  return /^[0-9A-Fa-f:.]+$/.test(ip) ? ip : undefined;
}

/** Maximum user-agent length forwarded upstream; longer values are truncated. */
const MAX_FORWARDED_USER_AGENT_LENGTH = 256;

/** A user agent fit to forward upstream, or undefined when absent/blank. */
export function sanitizeForwardableUserAgent(userAgent: string | undefined): string | undefined {
  const trimmed = userAgent?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_FORWARDED_USER_AGENT_LENGTH);
}
