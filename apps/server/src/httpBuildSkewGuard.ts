// FILE: httpBuildSkewGuard.ts
// Purpose: Apply the build-skew read-only degradation to HTTP write routes, so
//          the policy is not enforced on the WebSocket transport alone.
// Layer: Server transport security
// Exports: BUILD_SKEW_EXEMPT_HTTP_PATH_PREFIX, isBuildSkewExemptHttpPath,
//          isHttpRequestBuildSkewed, buildSkewHttpRejection,
//          addBuildSkewGuardedWriteRoute

import { WS_COMPATIBILITY_QUERY } from "@synara/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { isWsClientBuildSkewed } from "./wsCompatibility";

/**
 * The recovery path. Re-pairing is how a user fixes a skewed client, so these
 * routes MUST stay reachable while degraded — blocking them strands the very
 * session that needs to recover. This exemption is deliberate and explicit, not
 * a consequence of which routes happened to get the guard.
 */
export const BUILD_SKEW_EXEMPT_HTTP_PATH_PREFIX = "/api/auth/" as const;

export function isBuildSkewExemptHttpPath(pathname: string): boolean {
  return pathname.startsWith(BUILD_SKEW_EXEMPT_HTTP_PATH_PREFIX);
}

/**
 * Classifies an HTTP request's build identity, reusing the WebSocket rule for
 * the comparison itself. The identity travels in the query string under the
 * existing `WS_COMPATIBILITY_QUERY.clientBuild` key rather than a new HTTP-only
 * carrier.
 *
 * ONE DELIBERATE DIVERGENCE from the WebSocket path: a request that asserts no
 * build at all is NOT treated as skewed. The WS upgrade can fail those closed
 * because negotiation makes the build mandatory there — every client that
 * reaches the socket has stamped one. HTTP has no such negotiation, and these
 * routes accept explicit bearer auth from callers that are not the web client
 * and have no build to declare. Failing those closed would deny a class of
 * legitimate client outright, and would also mask the routes' own auth and
 * origin refusals behind a skew error.
 *
 * That is sound because skew is not an authorization boundary — auth and origin
 * checks are separate and unchanged. This guard exists to make the client's
 * read-only banner truthful, and a client that knows it is skewed is exactly
 * the one that stamps its build.
 */
export function isHttpRequestBuildSkewed(url: URL): boolean {
  const declaredBuild = url.searchParams.get(WS_COMPATIBILITY_QUERY.clientBuild)?.trim() ?? "";
  if (declaredBuild.length === 0) return false;
  return isWsClientBuildSkewed(url.searchParams);
}

export function buildSkewHttpRejection(
  headers: Record<string, string> = {},
): HttpServerResponse.HttpServerResponse {
  return HttpServerResponse.jsonUnsafe(
    {
      error:
        "This client runs a different Synara build than the server. Update both to the same version to make changes.",
    },
    { status: 409, headers },
  );
}

/**
 * Wraps a write handler so the skew check runs BEFORE any of its own logic —
 * before auth, before body reads, before anything is staged. Preflight passes
 * through untouched: CORS negotiation is not a write and must still answer so
 * the browser surfaces the 409 rather than an opaque CORS failure.
 */
export function guardHttpWriteAgainstBuildSkew<E, R>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
> {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (
      url &&
      request.method !== "OPTIONS" &&
      !isBuildSkewExemptHttpPath(url.pathname) &&
      isHttpRequestBuildSkewed(url)
    ) {
      return buildSkewHttpRejection();
    }
    return yield* handler;
  });
}

/**
 * The single registration seam for HTTP write routes. Registering through this
 * helper — rather than calling `HttpRouter.add` directly — is what makes a
 * future write route inherit the guard instead of reopening the gap the three
 * upload routes had.
 */
export function addBuildSkewGuardedWriteRoute<E, R>(
  method: Parameters<typeof HttpRouter.add>[0],
  path: Parameters<typeof HttpRouter.add>[1],
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
): Layer.Layer<never, never, Exclude<R, HttpServerRequest.HttpServerRequest>> {
  if (isBuildSkewExemptHttpPath(path)) {
    // A route cannot be both a guarded write and part of the recovery path.
    throw new Error(`Refusing to register ${path} as a build-skew guarded write route.`);
  }
  return HttpRouter.add(method, path, guardHttpWriteAgainstBuildSkew(handler)) as Layer.Layer<
    never,
    never,
    Exclude<R, HttpServerRequest.HttpServerRequest>
  >;
}
