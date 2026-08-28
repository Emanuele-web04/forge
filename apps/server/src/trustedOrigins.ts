// FILE: trustedOrigins.ts
// Purpose: Shared origin checks for browser-facing HTTP/WS routes that expose
//          local machine data only to Synara's own app surfaces.
// Layer: Server HTTP/security utility
// Exports: normalizeCorsOrigin, isTrustedAppOrigin,
//          shouldRejectUntrustedRequestOrigin

import { timingSafeEqual } from "node:crypto";

import {
  SYNARA_CANARY_DESKTOP_ORIGIN,
  SYNARA_DESKTOP_ORIGIN,
} from "@synara/shared/desktopIdentity";

import type { ServerConfigShape } from "./config";
import { isLoopbackHost, isWildcardHost } from "./startupAccess";

export const DESKTOP_APP_CORS_ORIGINS: ReadonlySet<string> = new Set([
  SYNARA_DESKTOP_ORIGIN,
  SYNARA_CANARY_DESKTOP_ORIGIN,
]);

export function normalizeCorsOrigin(rawOrigin: string | ReadonlyArray<string> | undefined) {
  if (Array.isArray(rawOrigin) && rawOrigin.length !== 1) {
    return null;
  }
  const value = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  const trimmed = value?.trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }
  const normalizedDesktopOrigin = trimmed.replace(/\/+$/, "");
  if (DESKTOP_APP_CORS_ORIGINS.has(normalizedDesktopOrigin)) {
    return normalizedDesktopOrigin;
  }
  try {
    const origin = new URL(trimmed).origin;
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

function normalizeHostForComparison(host: string): string {
  return (host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host).toLowerCase();
}

// Same-origin is trusted for local loopback, explicitly configured hosts, and
// wildcard binds where remote-reachable auth/session policy is the real gate.
function isTrustedRequestOriginHost(requestOrigin: string, config: ServerConfigShape): boolean {
  if (config.publicUrl && !isLoopbackHost(config.host)) {
    return false;
  }
  let requestHost: string;
  try {
    requestHost = new URL(requestOrigin).hostname;
  } catch {
    return false;
  }
  if (isLoopbackHost(requestHost)) {
    return true;
  }
  if (!config.host) {
    return false;
  }
  if (isWildcardHost(config.host)) {
    // Wildcard binds are explicit remote-reachable mode; same-origin browser
    // requests should pass this CSRF gate and let auth/session policy decide.
    return true;
  }
  return normalizeHostForComparison(requestHost) === normalizeHostForComparison(config.host);
}

export function isTrustedAppOrigin(input: {
  readonly origin: string | null;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
}) {
  return (
    input.origin !== null &&
    (input.origin === input.config.publicUrl?.origin ||
      (input.origin === input.requestOrigin &&
        isTrustedRequestOriginHost(input.requestOrigin, input.config)) ||
      input.origin === input.config.devUrl?.origin ||
      DESKTOP_APP_CORS_ORIGINS.has(input.origin))
  );
}

// Browser-facing requests must reject origins that are present but invalid,
// opaque (`Origin: null`), or unrelated. Authenticated non-browser requests may
// omit Origin; the explicit unauthenticated dev socket is stricter below.
export function shouldRejectUntrustedRequestOrigin(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
}) {
  if (input.rawOrigin === undefined) {
    return false;
  }
  const origin = normalizeCorsOrigin(input.rawOrigin);
  return (
    !origin ||
    !isTrustedAppOrigin({
      origin,
      requestOrigin: input.requestOrigin,
      config: input.config,
    })
  );
}

export function shouldRejectAuthMutationOrigin(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
  readonly credentialSource: "bearer" | "cookie";
}) {
  if (input.rawOrigin === undefined) {
    return input.credentialSource !== "bearer";
  }
  return shouldRejectUntrustedRequestOrigin(input);
}

/**
 * Built and remotely exposed servers require a real authenticated session.
 * The only unauthenticated mode left is the explicit Vite development server,
 * whose browser sockets must still present a trusted Origin header.
 */
export function requiresWebSocketAuthentication(
  config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl"> &
    Partial<Pick<ServerConfigShape, "devUrl">>,
): boolean {
  return (
    Boolean(config.authToken) ||
    Boolean(config.publicUrl) ||
    !isLoopbackHost(config.host) ||
    config.devUrl === undefined
  );
}

/** Legacy compatibility credential accepted only on a loopback-only server. */
export function isLegacyLoopbackTokenAccepted(input: {
  readonly config: Pick<ServerConfigShape, "authToken" | "host" | "publicUrl">;
  readonly token: string | null;
}): boolean {
  const expected = input.config.authToken;
  if (
    !isLoopbackHost(input.config.host) ||
    input.config.publicUrl ||
    !expected?.trim() ||
    input.token === null
  ) {
    return false;
  }
  const expectedBytes = Buffer.from(expected);
  const receivedBytes = Buffer.from(input.token);
  return (
    expectedBytes.byteLength === receivedBytes.byteLength &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

export function shouldRejectWebSocketRequestOrigin(input: {
  readonly rawOrigin: string | ReadonlyArray<string> | undefined;
  readonly requestOrigin: string;
  readonly config: ServerConfigShape;
}): boolean {
  if (input.rawOrigin === undefined && !requiresWebSocketAuthentication(input.config)) {
    return true;
  }
  return shouldRejectUntrustedRequestOrigin(input);
}
