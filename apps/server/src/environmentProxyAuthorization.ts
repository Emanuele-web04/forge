// FILE: environmentProxyAuthorization.ts
// Purpose: The LOCAL authorization gate in front of the `/env/:envId/*` proxy.
// Layer: Server / environment proxy
// Exports: EnvironmentProxyAuthorizer, EnvironmentProxyAuthorization,
//          makeEnvironmentProxyAuthorizer, parseCookieHeader,
//          requestOriginOf
//
// Why this exists at all
// ---------------------------------------------------------------------------
// The proxy attaches the environment's PROVISIONED credential to everything it
// forwards. Without a local gate, an unauthenticated caller that can reach the
// local socket is upgraded into a fully authenticated remote one: the request
// the local router would have answered with 401 comes back 200 with the remote
// server's data. The remote's own auth cannot catch this — by the time the
// request arrives there it is carrying a credential the remote itself issued.
//
// So the rule is: a proxied request must clear EXACTLY the same local bar as a
// local one, before any upstream is contacted.
//
// Both halves of that bar come from existing policy, never a parallel path:
//   - Session: `allowsImplicitOwnerSession` (remoteAccessPolicy.ts), the same
//     predicate the RPC WebSocket upgrade uses, then `ServerAuth`.
//   - Origin/CSRF: `shouldRejectUntrustedRequestOrigin` (trustedOrigins.ts),
//     the same check the WS upgrade and the auth mutation routes use. A
//     credential-attaching endpoint reachable from any web page is CSRF by
//     construction, and this proxy is the most powerful one the server has.
//
// Fail closed: anything unexpected — an unparseable target, a missing Host, an
// authentication defect — denies.

import type * as Http from "node:http";

import type { AuthRequest, ServerAuthShape } from "./auth/Services/ServerAuth";
import type { ServerConfigShape } from "./config";
import { allowsImplicitOwnerSession } from "./remoteAccessPolicy";
import { shouldRejectUntrustedRequestOrigin } from "./trustedOrigins";

export type EnvironmentProxyAuthorization =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly status: 400 | 401 | 403; readonly message: string };

/**
 * Decides whether one proxied request may proceed.
 *
 * Async because authentication reaches the session store. The proxy awaits it
 * before resolving an upstream, so a denial costs the remote host nothing —
 * not even a TCP connection.
 */
export type EnvironmentProxyAuthorizer = (input: {
  readonly request: Pick<Http.IncomingMessage, "url" | "headers">;
  readonly kind: "http" | "upgrade";
}) => Promise<EnvironmentProxyAuthorization>;

/** Splits a `Cookie` header into the name/value map `ServerAuth` expects. */
export function parseCookieHeader(
  raw: string | string[] | undefined,
): Record<string, string | undefined> {
  const joined = Array.isArray(raw) ? raw.join("; ") : (raw ?? "");
  const cookies: Record<string, string | undefined> = {};
  for (const part of joined.split(";")) {
    const pair = part.trim();
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    cookies[pair.slice(0, equals).trim()] = pair.slice(equals + 1);
  }
  return cookies;
}

/**
 * Reconstructs the URL the browser addressed, for the origin comparison.
 *
 * The scheme is inferred from the deployment's declared public origin rather
 * than from anything on the request: `x-forwarded-proto` is client-settable and
 * this is a security decision. Returns null when there is no usable Host, which
 * the caller treats as a denial.
 */
export function requestOriginOf(input: {
  readonly requestTarget: string | undefined;
  readonly host: string | string[] | undefined;
  readonly config: Pick<ServerConfigShape, "publicUrl">;
}): URL | null {
  const host = (Array.isArray(input.host) ? input.host[0] : input.host)?.trim();
  if (!host) return null;
  const scheme = input.config.publicUrl ? "https" : "http";
  try {
    return new URL(input.requestTarget ?? "/", `${scheme}://${host}`);
  } catch {
    return null;
  }
}

function toAuthRequest(input: {
  readonly headers: Http.IncomingHttpHeaders;
  readonly url: URL;
}): AuthRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(input.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return { headers, cookies: parseCookieHeader(input.headers.cookie), url: input.url };
}

/**
 * Builds the authorizer from the same services the local routes use.
 *
 * `runAuth` is the seam that runs an `Effect` on the caller's runtime — the
 * proxy lives on Node's raw request/upgrade handlers, outside any Effect fiber.
 * It must REJECT on failure; a resolved value means the session is real.
 */
export function makeEnvironmentProxyAuthorizer(deps: {
  readonly config: ServerConfigShape;
  readonly serverAuth: Pick<
    ServerAuthShape,
    "authenticateHttpRequest" | "authenticateWebSocketUpgrade"
  >;
  readonly runAuth: (
    effect: ReturnType<ServerAuthShape["authenticateHttpRequest"]>,
  ) => Promise<unknown>;
}): EnvironmentProxyAuthorizer {
  return async ({ request, kind }) => {
    const url = requestOriginOf({
      requestTarget: request.url,
      host: request.headers.host,
      config: deps.config,
    });
    if (!url) {
      return { allowed: false, status: 400, message: "Bad Request" };
    }
    // CSRF before authentication, exactly as the local mutation routes order
    // it: a cross-site page must be refused even when the browser's ambient
    // session cookie would have authenticated it.
    if (
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config: deps.config,
      })
    ) {
      return { allowed: false, status: 403, message: "Trusted request origin required." };
    }
    if (
      allowsImplicitOwnerSession({
        config: deps.config,
        legacyToken: url.searchParams.get("token"),
      })
    ) {
      return { allowed: true };
    }
    const authRequest = toAuthRequest({ headers: request.headers, url });
    try {
      await deps.runAuth(
        kind === "upgrade"
          ? (deps.serverAuth.authenticateWebSocketUpgrade(authRequest) as ReturnType<
              ServerAuthShape["authenticateHttpRequest"]
            >)
          : deps.serverAuth.authenticateHttpRequest(authRequest),
      );
      return { allowed: true };
    } catch {
      // Deliberately one answer for every failure. Distinguishing "no
      // credential" from "bad credential" from "session store unavailable"
      // tells a caller which of those it achieved, and none of them may pass.
      return { allowed: false, status: 401, message: "Unauthorized" };
    }
  };
}
