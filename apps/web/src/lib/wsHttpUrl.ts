// FILE: wsHttpUrl.ts
// Purpose: Resolves server HTTP URLs from the active WebSocket bridge so desktop <img>/download
// requests carry the same legacy startup token already used for the WS connection.
// Layer: Web utility
// Exports: resolveWsHttpUrl, toAttachmentPreviewUrl

// Maps a WS URL onto the HTTP URL for `rawPath` on that same server, forwarding the legacy
// token query param so authenticated GET routes can authorize without touching cookies.
// Returns null when `wsCandidate` is unusable, letting callers pick their own fallback.
function httpUrlFromWsUrl(wsCandidate: string, rawPath: string): string | null {
  try {
    const wsUrl = new URL(wsCandidate);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : wsUrl.protocol;
    const httpUrl = new URL(rawPath, `${protocol}//${wsUrl.host}`);
    const legacyToken = wsUrl.searchParams.get("token");
    if (legacyToken && !httpUrl.searchParams.has("token")) {
      httpUrl.searchParams.set("token", legacyToken);
    }
    return httpUrl.toString();
  } catch {
    return null;
  }
}

/**
 * HTTP URL for `rawPath` on the server behind `explicitWsUrl`.
 *
 * An environment's HTTP-backed routes must resolve from that environment's own
 * WS URL, never from the page's ambient one: a remote client resolving through
 * the global URL would send its request — and its payload — to the local server
 * instead.
 *
 * With no explicit URL the environment *is* the page's own server, so the
 * caller's existing local resolution is used unchanged (`localFallback`). That
 * keeps the single-local-server case byte-identical: auth still posts a bare
 * relative path, voice still resolves through the ambient WS URL.
 */
export function resolveEnvironmentHttpUrl(
  explicitWsUrl: string | null | undefined,
  rawPath: string,
  localFallback: (rawPath: string) => string = resolveWsHttpUrl,
): string {
  if (!explicitWsUrl) return localFallback(rawPath);
  return httpUrlFromWsUrl(explicitWsUrl, rawPath) ?? localFallback(rawPath);
}

/** Identity resolution for callers whose local behavior is a bare relative path. */
export const relativePathFallback = (rawPath: string): string => rawPath;

// Build a fully-qualified HTTP URL for `rawPath` against the same server the WS connection uses.
// On desktop the page is served from a custom protocol scheme, so <img>/<a download> with a
// relative path never reaches the server. We mirror the WS host and forward the legacy token
// query param so authenticated GET routes (attachments, local-image, …) can authorize the
// request without touching cookies.
export function resolveWsHttpUrl(rawPath: string): string {
  if (typeof window === "undefined") return rawPath;
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  const wsCandidate =
    typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0
      ? bridgeWsUrl
      : typeof envWsUrl === "string" && envWsUrl.length > 0
        ? envWsUrl
        : null;
  if (!wsCandidate) return new URL(rawPath, window.location.origin).toString();
  return (
    httpUrlFromWsUrl(wsCandidate, rawPath) ?? new URL(rawPath, window.location.origin).toString()
  );
}

export function toAttachmentPreviewUrl(rawUrl: string): string {
  if (rawUrl.startsWith("/")) {
    return resolveWsHttpUrl(rawUrl);
  }
  return rawUrl;
}
