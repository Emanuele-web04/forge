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
 * Resolves a rate-limiting key from a request, preferring the first
 * `x-forwarded-for` hop and falling back to the socket's remote address.
 *
 * Both are needed. Behind a proxy only the forwarded header names the caller;
 * with no proxy the header is absent and, without the socket fallback, every
 * caller would share one bucket — one instance's tenth sign-in would lock out
 * everybody else, which is exactly the deployment a self-hoster runs.
 *
 * The header is caller-controlled, so this bounds honest traffic and casual
 * abuse rather than a determined attacker. `"unknown"` is a shared bucket of
 * last resort for requests that expose neither.
 */
export function resolveClientIp(source: ClientIpSource): string {
  const forwarded = source.forwardedFor?.split(",")[0]?.trim();
  if (forwarded) return forwarded;

  const remote = source.remoteAddress()?.trim();
  if (remote) return remote;

  return "unknown";
}

export function clientIp(c: Context): string {
  return resolveClientIp({
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
  });
}
