// FILE: wsUrlPathPrefix.ts
// Purpose: Preserve an environment's URL path prefix when deriving any other
//          path on that same server.
// Layer: Web URL utility (pure)
// Exports: wsUrlPathPrefix, withWsPathPrefix

import { WS_BOOTSTRAP_PATH, WS_FEATURE_PATH, WS_NEGOTIATE_HTTP_PATH } from "@synara/contracts";

/**
 * Socket paths a registered environment URL may already carry.
 *
 * Longest first: `/ws/bootstrap` must not be shortened to `/ws/` by the `/ws`
 * arm.
 */
const SOCKET_PATH_SUFFIXES: readonly string[] = [
  WS_BOOTSTRAP_PATH,
  WS_NEGOTIATE_HTTP_PATH,
  WS_FEATURE_PATH,
];

/**
 * The path an environment is mounted UNDER, derived from its WS URL.
 *
 * A remote environment reached through the single-origin proxy lives at
 * `/env/<id>/…` on the LOCAL origin: host and protocol are identical to the
 * page's own server and the path prefix is the only thing that distinguishes
 * them. Any URL derived from that WS URL — auth, voice upload, attachments —
 * must therefore carry the prefix, or it addresses the local server with the
 * remote's payload while looking correct in every log.
 *
 * Deliberately derived from the URL rather than composed from
 * `ENV_PROXY_PATH_PREFIX` and an id: this returns whatever the registered URL
 * actually says, so a differently-mounted environment resolves correctly
 * without this module knowing the proxy's route shape.
 *
 * Returns `""` (not `"/"`) for a server mounted at the root, so callers can
 * concatenate unconditionally.
 */
export function wsUrlPathPrefix(wsUrl: URL): string {
  let pathname = wsUrl.pathname;
  for (const suffix of SOCKET_PATH_SUFFIXES) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, pathname.length - suffix.length);
      break;
    }
  }
  while (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  return pathname;
}

/**
 * Mounts `rawPath` under `prefix`.
 *
 * `rawPath` may carry a query string; the prefix only ever goes on the front,
 * so the query survives untouched. The prefix is not deduplicated against a
 * path that already contains it — callers pass server-absolute paths
 * (`/api/auth/session`), and silently recognising an already-prefixed path
 * would make a double-prefix bug invisible instead of loud.
 */
export function withWsPathPrefix(prefix: string, rawPath: string): string {
  if (prefix.length === 0) return rawPath;
  return rawPath.startsWith("/") ? `${prefix}${rawPath}` : `${prefix}/${rawPath}`;
}
