import {
  BROWSER_ANNOTATION_MAX_COMMENT_LENGTH,
  BROWSER_ANNOTATION_MAX_DOCUMENT_KEY_LENGTH,
  BROWSER_ANNOTATION_MAX_FINGERPRINT_LENGTH,
  BROWSER_ANNOTATION_MAX_ID_LENGTH,
  BROWSER_ANNOTATION_MAX_MARKERS,
  BROWSER_ANNOTATION_MAX_NAME_LENGTH,
  BROWSER_ANNOTATION_MAX_PAGE_TITLE_LENGTH,
  BROWSER_ANNOTATION_MAX_ROLE_LENGTH,
  BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH,
  BROWSER_ANNOTATION_MAX_TAG_NAME_LENGTH,
  BROWSER_ANNOTATION_MAX_TEXT_LENGTH,
  BROWSER_ANNOTATION_MAX_URL_LENGTH,
  type BrowserAnnotation,
  type BrowserAnnotationMarker,
  type BrowserAnnotationSource,
  type BrowserAnnotationTheme,
} from "@synara/contracts";
import { sanitizeBrowserAnnotationPageTitle } from "@synara/shared/browserAnnotations";

export const BROWSER_ANNOTATION_PROTOCOL_VERSION = 1 as const;

export interface AnnotationGuestReadyMessage {
  readonly version: 1;
  readonly kind: "ready";
  readonly documentToken: string;
  readonly source: BrowserAnnotationSource;
}

export interface AnnotationGuestCommittedMessage {
  readonly version: 1;
  readonly kind: "committed";
  readonly documentToken: string;
  readonly sessionId: string;
  readonly annotation: BrowserAnnotation;
}

export interface AnnotationGuestCancelledMessage {
  readonly version: 1;
  readonly kind: "cancelled";
  readonly documentToken: string;
  readonly sessionId: string;
}

export interface AnnotationGuestMarkersProjectedMessage {
  readonly version: 1;
  readonly kind: "markers-projected";
  readonly documentToken: string;
  readonly projectionVersion: number;
  readonly projectedMarkerIds: readonly string[];
}

export type AnnotationGuestMessage =
  | AnnotationGuestReadyMessage
  | AnnotationGuestCommittedMessage
  | AnnotationGuestCancelledMessage
  | AnnotationGuestMarkersProjectedMessage;

export type AnnotationGuestCommand =
  | {
      readonly version: 1;
      readonly kind: "start";
      readonly documentToken: string;
      readonly sessionId: string;
      readonly theme: BrowserAnnotationTheme;
    }
  | {
      readonly version: 1;
      readonly kind: "cancel";
      readonly documentToken: string;
      readonly sessionId: string;
    }
  | {
      readonly version: 1;
      readonly kind: "sync-markers";
      readonly documentToken: string;
      readonly projectionVersion: number;
      readonly markers: readonly BrowserAnnotationMarker[];
    }
  | {
      readonly version: 1;
      readonly kind: "refresh-document";
      readonly documentToken: string;
    }
  | {
      readonly version: 1;
      readonly kind: "announce-ready";
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(
  value: unknown,
  maximumLength: number,
  options: { readonly allowEmpty?: boolean; readonly uppercase?: boolean } = {},
): string | null {
  if (typeof value !== "string") return null;
  // Bound the untrusted structured-clone payload before normalization. Without
  // this, megabytes of whitespace could collapse to a valid tiny value and be
  // retained by the main-process marker projection.
  if (value.length > maximumLength) return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if ((!options.allowEmpty && normalized.length === 0) || normalized.length > maximumLength) {
    return null;
  }
  return options.uppercase ? normalized.toUpperCase() : normalized;
}

function parseIdentifier(value: unknown): string | null {
  const identifier = boundedString(value, BROWSER_ANNOTATION_MAX_ID_LENGTH);
  return identifier && /^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(identifier) ? identifier : null;
}

const SAFE_RESOLVED_COLOR_PATTERN =
  /^(?:(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([+\-0-9.eE,%\s/]+\)|color\(srgb(?:-linear)?[+\-0-9.eE,%\s/]+\))$/u;

function parseResolvedColor(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 64) return null;
  const color = value.trim();
  return color.length > 0 && SAFE_RESOLVED_COLOR_PATTERN.test(color) ? color : null;
}

export function parseBrowserAnnotationTheme(value: unknown): BrowserAnnotationTheme | null {
  if (!isRecord(value) || (value.mode !== "light" && value.mode !== "dark")) return null;
  const accent = parseResolvedColor(value.accent);
  const surface = parseResolvedColor(value.surface);
  const text = parseResolvedColor(value.text);
  const mutedText = parseResolvedColor(value.mutedText);
  const border = parseResolvedColor(value.border);
  const focusBorder = parseResolvedColor(value.focusBorder);
  const primary = parseResolvedColor(value.primary);
  const primaryText = parseResolvedColor(value.primaryText);
  return accent && surface && text && mutedText && border && focusBorder && primary && primaryText
    ? {
        mode: value.mode,
        accent,
        surface,
        text,
        mutedText,
        border,
        focusBorder,
        primary,
        primaryText,
      }
    : null;
}

function parseUrl(value: unknown): string | null {
  const url = boundedString(value, BROWSER_ANNOTATION_MAX_URL_LENGTH);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseSource(value: unknown): BrowserAnnotationSource | null {
  if (!isRecord(value)) return null;
  const url = parseUrl(value.url);
  const pageTitle = boundedString(value.pageTitle, BROWSER_ANNOTATION_MAX_PAGE_TITLE_LENGTH, {
    allowEmpty: true,
  });
  return url && pageTitle !== null
    ? { url, pageTitle: sanitizeBrowserAnnotationPageTitle(pageTitle) }
    : null;
}

function parseNullableText(value: unknown, maximumLength: number): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  if (value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().length === 0) return null;
  const parsed = boundedString(value, maximumLength);
  return parsed ?? undefined;
}

function parseFingerprint(value: unknown): string | null {
  const fingerprint = boundedString(value, BROWSER_ANNOTATION_MAX_FINGERPRINT_LENGTH);
  return fingerprint && /^fnv1a64:[0-9a-f]{16}$/.test(fingerprint) ? fingerprint : null;
}

function parseDocumentKey(value: unknown): string | null {
  const key = boundedString(value, BROWSER_ANNOTATION_MAX_DOCUMENT_KEY_LENGTH);
  return key && /^sha256:[0-9a-f]{64}$/u.test(key) ? key : null;
}

function parseMarker(value: unknown): BrowserAnnotationMarker | null {
  if (!isRecord(value)) return null;
  const id = parseIdentifier(value.id);
  const ordinal =
    typeof value.ordinal === "number" && Number.isSafeInteger(value.ordinal) && value.ordinal >= 1
      ? value.ordinal
      : null;
  const source = parseSource(value.source);
  const documentKey = parseDocumentKey(value.documentKey);
  const selector = boundedString(value.selector, BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH);
  const fingerprint = parseFingerprint(value.fingerprint);
  if (!id || ordinal === null || !documentKey || !source || !selector || !fingerprint) {
    return null;
  }
  return { id, ordinal, documentKey, source, selector, fingerprint };
}

export function parseBrowserAnnotationMarkers(
  value: unknown,
): readonly BrowserAnnotationMarker[] | null {
  if (!Array.isArray(value) || value.length > BROWSER_ANNOTATION_MAX_MARKERS) return null;
  const markers: BrowserAnnotationMarker[] = [];
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  for (const candidate of value) {
    const marker = parseMarker(candidate);
    if (!marker || ids.has(marker.id) || ordinals.has(marker.ordinal)) return null;
    ids.add(marker.id);
    ordinals.add(marker.ordinal);
    markers.push(marker);
  }
  return markers;
}

function looksSensitive(value: string): boolean {
  return (
    /\b(?:bearer|authorization|password|passwd|secret|api[-_ ]?key)\b/i.test(value) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(value) ||
    /\b(?:\d[ -]*?){13,19}\b/.test(value)
  );
}

function parseAnnotation(value: unknown): BrowserAnnotation | null {
  if (!isRecord(value)) return null;
  const id = parseIdentifier(value.id);
  const source = parseSource(value.source);
  const selector = boundedString(value.selector, BROWSER_ANNOTATION_MAX_SELECTOR_LENGTH);
  const tagName = boundedString(value.tagName, BROWSER_ANNOTATION_MAX_TAG_NAME_LENGTH, {
    uppercase: true,
  });
  const role = parseNullableText(value.role, BROWSER_ANNOTATION_MAX_ROLE_LENGTH);
  let name = parseNullableText(value.name, BROWSER_ANNOTATION_MAX_NAME_LENGTH);
  let text = parseNullableText(value.text, BROWSER_ANNOTATION_MAX_TEXT_LENGTH);
  const fingerprint = parseFingerprint(value.fingerprint);
  const comment = parseNullableText(value.comment, BROWSER_ANNOTATION_MAX_COMMENT_LENGTH);
  const capturedAt = boundedString(value.capturedAt, 40);
  if (
    !id ||
    !source ||
    !selector ||
    !tagName ||
    role === undefined ||
    name === undefined ||
    text === undefined ||
    !fingerprint ||
    comment === undefined ||
    !capturedAt ||
    !Number.isFinite(Date.parse(capturedAt))
  ) {
    return null;
  }
  if (["INPUT", "TEXTAREA", "SELECT", "OPTION"].includes(tagName)) {
    text = null;
  }
  if (name && looksSensitive(name)) name = null;
  if (text && looksSensitive(text)) text = null;
  return {
    id,
    source,
    selector,
    tagName,
    role,
    name,
    text,
    fingerprint,
    comment,
    capturedAt: new Date(capturedAt).toISOString(),
  };
}

export function parseAnnotationGuestMessage(value: unknown): AnnotationGuestMessage | null {
  if (!isRecord(value) || value.version !== BROWSER_ANNOTATION_PROTOCOL_VERSION) return null;
  const documentToken = parseIdentifier(value.documentToken);
  if (!documentToken) return null;
  if (value.kind === "ready") {
    const source = parseSource(value.source);
    return source
      ? { version: BROWSER_ANNOTATION_PROTOCOL_VERSION, kind: "ready", documentToken, source }
      : null;
  }
  if (value.kind === "committed") {
    const sessionId = parseIdentifier(value.sessionId);
    const annotation = parseAnnotation(value.annotation);
    return sessionId && annotation
      ? {
          version: BROWSER_ANNOTATION_PROTOCOL_VERSION,
          kind: "committed",
          documentToken,
          sessionId,
          annotation,
        }
      : null;
  }
  if (value.kind === "cancelled") {
    const sessionId = parseIdentifier(value.sessionId);
    return sessionId
      ? {
          version: BROWSER_ANNOTATION_PROTOCOL_VERSION,
          kind: "cancelled",
          documentToken,
          sessionId,
        }
      : null;
  }
  if (value.kind === "markers-projected") {
    const projectionVersion = value.projectionVersion;
    if (
      typeof projectionVersion !== "number" ||
      !Number.isSafeInteger(projectionVersion) ||
      projectionVersion < 0 ||
      !Array.isArray(value.projectedMarkerIds) ||
      value.projectedMarkerIds.length > BROWSER_ANNOTATION_MAX_MARKERS
    ) {
      return null;
    }
    const projectedMarkerIds = value.projectedMarkerIds.map(parseIdentifier);
    if (
      projectedMarkerIds.some((id) => id === null) ||
      new Set(projectedMarkerIds).size !== projectedMarkerIds.length
    ) {
      return null;
    }
    return {
      version: BROWSER_ANNOTATION_PROTOCOL_VERSION,
      kind: "markers-projected",
      documentToken,
      projectionVersion,
      projectedMarkerIds: projectedMarkerIds as string[],
    };
  }
  return null;
}
