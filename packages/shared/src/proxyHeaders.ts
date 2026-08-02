// FILE: proxyHeaders.ts
// Purpose: The one place that decides which headers cross the environment proxy
//          in each direction, and how cookies are scoped per environment.
// Layer: Shared runtime (pure)
// Exports: HOP_BY_HOP_HEADERS, forwardableRequestHeaders,
//          forwardableResponseHeaders, scopeSetCookieForEnvironment,
//          environmentCookiePath, environmentCookieName,
//          environmentCookieHeader
//
// Two independent concerns, deliberately in one module so they cannot drift:
//
//  1. HOP-BY-HOP headers (RFC 9110 §7.6.1) describe THIS connection, not the
//     message. Forwarding them makes the upstream believe things about a
//     connection it does not have. They are stripped in both directions.
//
//  2. COOKIE ISOLATION. Every environment is served from the SAME origin, so
//     one browser cookie jar holds the LOCAL server's session cookie and every
//     environment's. Two things follow, and both are enforced here:
//
//       - Outbound: a proxied request must carry ONLY the cookies belonging to
//         the environment it addresses. The local session cookie is issued with
//         `Path=/`, so the browser attaches it to every `/env/<id>/*` request;
//         relaying it would hand the local session token to every remote
//         environment operator.
//       - Inbound: an upstream `Set-Cookie` is both re-scoped to `/env/<id>`
//         and RENAMED into that environment's namespace. Path scoping alone is
//         not isolation — every Synara server names its session cookie
//         `synara_session`, so two environments' tokens would occupy the same
//         name in one jar and the last writer would win.

import { ENV_PROXY_PATH_PREFIX } from "@synara/contracts";

/**
 * Headers whose meaning is bound to a single hop.
 *
 * `connection` and `upgrade` are here even though the WS path handles the
 * upgrade itself: the HTTP path must never relay them, or a plain request
 * could talk the upstream into switching protocols out from under the proxy.
 */
export const HOP_BY_HOP_HEADERS: ReadonlySet<string> = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Headers we never let the CLIENT set on a proxied request, because the proxy
 * itself is the authority on them.
 *
 * `host` is rewritten to the upstream. The `x-forwarded-*` family is dropped so
 * a client cannot forge its own provenance — the proxy sets them, or nobody
 * does. `authorization` is dropped and replaced with the environment's own
 * provisioned credential: a browser must never be able to choose which
 * credential the local server presents to a remote host.
 *
 * `cookie` is here because it is never forwarded verbatim: the jar is shared
 * across the local server and every environment, so the header is rebuilt from
 * scratch out of exactly the cookies this environment issued
 * (`environmentCookieHeader`).
 */
const CLIENT_CONTROLLED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "cookie",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

function isHopByHop(name: string): boolean {
  return HOP_BY_HOP_HEADERS.has(name.toLowerCase());
}

/**
 * Additional per-message hop-by-hop names listed in the `Connection` header.
 * RFC 9110 lets a hop nominate its own; honouring that list is required, and
 * skipping it is how a `Connection: x-internal-trust` header survives a proxy.
 */
function connectionNominatedHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): ReadonlySet<string> {
  const raw = headers["connection"] ?? headers["Connection"];
  const value = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  const nominated = new Set<string>();
  for (const token of value.split(",")) {
    const name = token.trim().toLowerCase();
    if (name.length > 0) nominated.add(name);
  }
  return nominated;
}

/**
 * Separator between the environment namespace and the upstream's own cookie
 * name.
 *
 * `~` is a valid cookie-name character (RFC 9110 token) and is NOT in the
 * environment-id charset (`environmentProxyPath.ts`), so `env~<id>~<name>`
 * splits back into its two parts unambiguously no matter how either is spelled.
 */
const ENVIRONMENT_COOKIE_PREFIX = "env";
const ENVIRONMENT_COOKIE_SEPARATOR = "~";

/** The name an upstream cookie is stored under in the shared browser jar. */
export function environmentCookieName(input: {
  readonly environmentId: string;
  readonly cookieName: string;
}): string {
  return `${ENVIRONMENT_COOKIE_PREFIX}${ENVIRONMENT_COOKIE_SEPARATOR}${input.environmentId}${ENVIRONMENT_COOKIE_SEPARATOR}${input.cookieName}`;
}

function namespacePrefix(environmentId: string): string {
  return `${ENVIRONMENT_COOKIE_PREFIX}${ENVIRONMENT_COOKIE_SEPARATOR}${environmentId}${ENVIRONMENT_COOKIE_SEPARATOR}`;
}

/**
 * Rebuilds the `Cookie` header for one environment.
 *
 * DEFAULT-DENY: a cookie crosses only if it carries this environment's
 * namespace, and it crosses under its ORIGINAL name so the upstream sees the
 * cookie it set. Everything else — the local server's `synara_session`, another
 * environment's namespaced cookie, anything a page script wrote — is dropped.
 * Returns undefined when nothing remains, so the header is omitted rather than
 * sent empty.
 */
export function environmentCookieHeader(
  rawCookie: string | readonly string[] | undefined,
  environmentId: string,
): string | undefined {
  if (rawCookie === undefined) return undefined;
  const joined = Array.isArray(rawCookie) ? rawCookie.join("; ") : (rawCookie as string);
  const prefix = namespacePrefix(environmentId);
  const kept: string[] = [];
  for (const part of joined.split(";")) {
    const pair = part.trim();
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    if (equals <= 0) continue;
    const name = pair.slice(0, equals);
    if (!name.startsWith(prefix)) continue;
    const upstreamName = name.slice(prefix.length);
    if (upstreamName.length === 0) continue;
    kept.push(`${upstreamName}=${pair.slice(equals + 1)}`);
  }
  return kept.length > 0 ? kept.join("; ") : undefined;
}

/**
 * Request headers to send upstream. Everything not excluded passes verbatim.
 *
 * `environmentId` is required rather than optional: the cookie rewrite is the
 * only thing standing between the local session token and every remote
 * environment, and an optional parameter is a rewrite someone can forget.
 */
export function forwardableRequestHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  environmentId: string,
): Record<string, string | string[]> {
  const nominated = connectionNominatedHeaders(headers);
  const out: Record<string, string | string[]> = {};
  let rawCookie: string | string[] | undefined;
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (isHopByHop(name) || nominated.has(name)) continue;
    if (name === "cookie") {
      rawCookie = value;
      continue;
    }
    if (CLIENT_CONTROLLED_REQUEST_HEADERS.has(name)) continue;
    out[name] = value;
  }
  const cookie = environmentCookieHeader(rawCookie, environmentId);
  if (cookie !== undefined) out["cookie"] = cookie;
  return out;
}

/** Response headers to return to the browser, with `Set-Cookie` re-scoped. */
export function forwardableResponseHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  environmentId: string,
): Record<string, string | string[]> {
  const nominated = connectionNominatedHeaders(headers);
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    const name = key.toLowerCase();
    if (isHopByHop(name) || nominated.has(name)) continue;
    if (name === "set-cookie") {
      const cookies = Array.isArray(value) ? value : [value];
      out[name] = cookies.map((cookie) => scopeSetCookieForEnvironment(cookie, environmentId));
      continue;
    }
    out[name] = value;
  }
  return out;
}

/** The URL path prefix an environment's cookies must be confined to. */
export function environmentCookiePath(environmentId: string): string {
  return `${ENV_PROXY_PATH_PREFIX}/${environmentId}`;
}

const COOKIE_ATTRIBUTES_TO_REPLACE: ReadonlySet<string> = new Set(["path", "domain"]);

/**
 * Confines one `Set-Cookie` to its environment, in both name and path.
 *
 * The NAME is namespaced because every Synara server calls its session cookie
 * `synara_session`: two environments would otherwise write the same name into
 * one jar and clobber each other. The PATH is REPLACED, not merged: the
 * upstream sets `Path=/` because it believes it owns the origin, and honouring
 * that would broadcast its session cookie to every other environment on this
 * origin. The upstream's path is not information we can preserve — it is the
 * exact thing that is wrong once the response is proxied.
 *
 * Only parts[1..] are attributes. parts[0] is the name-value pair, and
 * filtering it as though it were an attribute would DELETE any cookie that
 * happens to be named `path` or `domain`.
 */
export function scopeSetCookieForEnvironment(setCookie: string, environmentId: string): string {
  const parts = setCookie.split(";");
  const [pair = "", ...attributes] = parts;
  const equals = pair.indexOf("=");
  // A `Set-Cookie` with no `=` is not a cookie we can rename; forward the
  // attributes rewrite only, so a malformed header cannot silently become a
  // cookie under some other environment's name.
  const cookieName = equals > 0 ? pair.slice(0, equals).trim() : null;
  const renamed =
    cookieName === null
      ? pair
      : `${environmentCookieName({ environmentId, cookieName })}=${pair.slice(equals + 1)}`;
  const kept = attributes.filter((attribute) => {
    const name = attribute.trim().split("=")[0]?.trim().toLowerCase() ?? "";
    // `Domain` is dropped too: a domain-scoped cookie ignores path scoping for
    // subdomains and would leak across environments the same way.
    return !COOKIE_ATTRIBUTES_TO_REPLACE.has(name);
  });
  return [renamed, ...kept, ` Path=${environmentCookiePath(environmentId)}`].join(";");
}
