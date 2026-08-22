import type { BrowserAnnotationMarker } from "@synara/contracts";

import type { AnnotationGuestCommand } from "./protocol";

// Literal, dependency-free mirror for the sandboxed preload. A focused test
// keeps these values aligned with the public contracts.
export const GUEST_ANNOTATION_PROTOCOL_VERSION = 1 as const;
export const GUEST_ANNOTATION_MAX_COMMENT_LENGTH = 4_000;
export const GUEST_ANNOTATION_MAX_NAME_LENGTH = 256;
export const GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH = 256;
export const GUEST_ANNOTATION_MAX_ROLE_LENGTH = 64;
export const GUEST_ANNOTATION_MAX_SELECTOR_LENGTH = 1_024;
export const GUEST_ANNOTATION_MAX_TAG_NAME_LENGTH = 64;
export const GUEST_ANNOTATION_MAX_TEXT_LENGTH = 280;
export const GUEST_ANNOTATION_MAX_URL_LENGTH = 2_048;
const GUEST_ANNOTATION_MAX_MARKERS = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.length <= 128 && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
  );
}

function validResolvedColor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([+\-0-9.eE,%\s/]+\)|color\(srgb(?:-linear)?[+\-0-9.eE,%\s/]+\))$/u.test(
      value.trim(),
    )
  );
}

function validTheme(value: unknown): boolean {
  if (!isRecord(value) || (value.mode !== "light" && value.mode !== "dark")) return false;
  return [
    value.accent,
    value.surface,
    value.text,
    value.mutedText,
    value.border,
    value.focusBorder,
    value.primary,
    value.primaryText,
  ].every(validResolvedColor);
}

function validMarker(value: unknown): value is BrowserAnnotationMarker {
  if (!isRecord(value) || !isRecord(value.source)) return false;
  return (
    validIdentifier(value.id) &&
    typeof value.ordinal === "number" &&
    Number.isSafeInteger(value.ordinal) &&
    value.ordinal >= 1 &&
    typeof value.documentKey === "string" &&
    /^sha256:[0-9a-f]{64}$/.test(value.documentKey) &&
    typeof value.source.url === "string" &&
    value.source.url.length <= GUEST_ANNOTATION_MAX_URL_LENGTH &&
    typeof value.source.pageTitle === "string" &&
    value.source.pageTitle.length <= GUEST_ANNOTATION_MAX_PAGE_TITLE_LENGTH &&
    typeof value.selector === "string" &&
    value.selector.length > 0 &&
    value.selector.length <= GUEST_ANNOTATION_MAX_SELECTOR_LENGTH &&
    typeof value.fingerprint === "string" &&
    /^fnv1a64:[0-9a-f]{16}$/.test(value.fingerprint)
  );
}

export function isGuestAnnotationCommand(value: unknown): value is AnnotationGuestCommand {
  if (
    !isRecord(value) ||
    value.version !== GUEST_ANNOTATION_PROTOCOL_VERSION ||
    !validIdentifier(value.documentToken)
  ) {
    return false;
  }
  if (value.kind === "start") {
    return validIdentifier(value.sessionId) && validTheme(value.theme);
  }
  if (value.kind === "cancel") return validIdentifier(value.sessionId);
  if (value.kind === "refresh-document") return true;
  return (
    value.kind === "sync-markers" &&
    typeof value.projectionVersion === "number" &&
    Number.isSafeInteger(value.projectionVersion) &&
    value.projectionVersion >= 0 &&
    Array.isArray(value.markers) &&
    value.markers.length <= GUEST_ANNOTATION_MAX_MARKERS &&
    value.markers.every(validMarker)
  );
}
