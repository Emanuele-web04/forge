// FILE: mediaPermissions.ts
// Purpose: Centralizes desktop media-permission guards for microphone capture.
// Layer: Desktop permission helper
// Exports: shouldAllowMediaPermissionRequest, isTrustedMediaPermissionRequest
// Depends on: Electron permission-request detail shape.

export interface MediaPermissionRequester {
  isDestroyed(): boolean;
  getURL?(): string;
}

// Electron marks `mediaTypes` as optional, so audio-only requests may omit it.
// Treat a missing value as "potentially audio" only after the caller has proved
// that the request came from Synara's own renderer. Mixed camera/microphone
// requests are rejected instead of silently granting the broader capability.
export function shouldAllowMediaPermissionRequest(details: unknown): boolean {
  if (typeof details !== "object" || details === null) {
    return true;
  }
  const record = details as Record<string, unknown>;
  if (Array.isArray(record.mediaTypes) && record.mediaTypes.length > 0) {
    return record.mediaTypes.every((mediaType) => mediaType === "audio");
  }
  if (typeof record.mediaType === "string") {
    return record.mediaType === "audio";
  }
  return true;
}

function comparableOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    return `${url.protocol.toLowerCase()}//${url.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

function hasTrustedMainFrameOrigin(
  requester: MediaPermissionRequester,
  details: unknown,
  requestingOrigin?: string,
): boolean {
  if (typeof details !== "object" || details === null) return true;
  const record = details as Record<string, unknown>;
  if (record.isMainFrame === false || typeof record.embeddingOrigin === "string") {
    return false;
  }

  const rendererOrigin = requester.getURL ? comparableOrigin(requester.getURL()) : null;
  if (!rendererOrigin) return true;
  const reportedOrigins = [requestingOrigin, record.requestingUrl, record.securityOrigin]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map(comparableOrigin);
  return (
    reportedOrigins.length === 0 || reportedOrigins.every((origin) => origin === rendererOrigin)
  );
}

export function isTrustedMediaPermissionRequest(
  requester: MediaPermissionRequester | null,
  trustedRequester: MediaPermissionRequester | null,
  details: unknown,
  requestingOrigin?: string,
): boolean {
  if (!requester || requester !== trustedRequester || requester.isDestroyed()) {
    return false;
  }
  if (!shouldAllowMediaPermissionRequest(details)) {
    return false;
  }
  return hasTrustedMainFrameOrigin(requester, details, requestingOrigin);
}
