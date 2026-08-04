const REDACTED_VALUE = "REDACTED";

const SAFE_QUERY_KEYS = new Set([
  "lang",
  "language",
  "locale",
  "mode",
  "order",
  "page",
  "section",
  "sort",
  "tab",
  "view",
]);

const SAFE_STATIC_PATH_SEGMENTS = new Set([
  "about",
  "activity",
  "app",
  "articles",
  "blog",
  "board",
  "boards",
  "calendar",
  "code",
  "dashboard",
  "details",
  "docs",
  "documentation",
  "download",
  "downloads",
  "editor",
  "features",
  "files",
  "general",
  "help",
  "history",
  "home",
  "index",
  "install",
  "installation",
  "issues",
  "landing",
  "next",
  "overview",
  "page",
  "pages",
  "pricing",
  "preview",
  "product",
  "products",
  "project",
  "projects",
  "repos",
  "repositories",
  "search",
  "settings",
  "support",
  "task",
  "tasks",
  "team",
  "teams",
  "thread",
  "threads",
  "tickets",
  "timeline",
  "workspace",
  "workspaces",
]);

const SAFE_STATIC_QUERY_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  mode: new Set([
    "auto",
    "compact",
    "dark",
    "default",
    "edit",
    "expanded",
    "light",
    "preview",
    "view",
  ]),
  order: new Set(["asc", "desc"]),
  section: new Set([
    "activity",
    "code",
    "comments",
    "details",
    "features",
    "files",
    "general",
    "history",
    "install",
    "installation",
    "overview",
    "preview",
    "settings",
  ]),
  sort: new Set(["created", "date", "name", "position", "priority", "status", "title", "updated"]),
  tab: new Set([
    "activity",
    "code",
    "comments",
    "details",
    "files",
    "general",
    "history",
    "overview",
    "preview",
    "settings",
  ]),
  view: new Set([
    "board",
    "calendar",
    "compact",
    "details",
    "expanded",
    "grid",
    "kanban",
    "list",
    "preview",
    "table",
    "timeline",
  ]),
};

const SENSITIVE_PATH_KEYS = new Set([
  "account",
  "accounts",
  "auth",
  "authorize",
  "callback",
  "client",
  "clients",
  "contact",
  "contacts",
  "credential",
  "credentials",
  "customer",
  "customers",
  "employee",
  "employees",
  "invite",
  "invites",
  "join",
  "magic",
  "member",
  "members",
  "oauth",
  "patient",
  "patients",
  "people",
  "person",
  "profile",
  "profiles",
  "record",
  "records",
  "reset",
  "s",
  "session",
  "sessions",
  "share",
  "shared",
  "shares",
  "staff",
  "token",
  "tokens",
  "user",
  "users",
  "verification",
  "verify",
]);

const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u;
const EXPOSED_CREDENTIAL_PATTERN =
  /\b(?:authorization|password|passwd|secret|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|session[-_ ]?token|credential)s?\s*(?::|=)\s*\S+/iu;
const BEARER_CREDENTIAL_PATTERN = /\bbearer\s+\S+/iu;
const URL_CREDENTIAL_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/iu;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/u;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;
const LONG_HEX_IDENTIFIER_PATTERN = /\b[0-9a-f]{24,}\b/iu;
const OPAQUE_IDENTIFIER_CANDIDATE_PATTERN = /[A-Za-z0-9._~+/-]{12,}/gu;

function decodeForInspection(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isPaymentCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/gu, "");
  if (
    digits.length < 13 ||
    digits.length > 19 ||
    !/^\d+$/u.test(digits) ||
    /^(\d)\1+$/u.test(digits)
  ) {
    return false;
  }
  let checksum = 0;
  const parity = digits.length % 2;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = Number(digits[index]);
    if (index % 2 === parity) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    checksum += digit;
  }
  return checksum % 10 === 0;
}

function containsPaymentCardNumber(value: string): boolean {
  const candidates = value.match(/(?:\d[ -]?){13,19}/gu) ?? [];
  return candidates.some(isPaymentCardNumber);
}

function isOpaqueIdentifier(value: string, fullTitle: string): boolean {
  const hasLetter = /[A-Za-z]/u.test(value);
  const hasDigit = /\d/u.test(value);
  if (!hasLetter || !hasDigit) return false;
  if (value.length >= 24) return true;
  if (value !== fullTitle || value.length < 12) return false;
  return /[A-Z]/u.test(value) && /[a-z]/u.test(value);
}

/**
 * Removes page titles that appear to expose private identifiers or credentials.
 *
 * Page titles are controlled by the visited document and can include account
 * details, reset tokens, or form values. Ordinary human-readable titles are
 * preserved verbatim so they remain useful annotation context.
 */
export function sanitizeBrowserAnnotationPageTitle(value: string): string {
  const title = value.trim();
  if (
    EMAIL_PATTERN.test(title) ||
    EXPOSED_CREDENTIAL_PATTERN.test(title) ||
    BEARER_CREDENTIAL_PATTERN.test(title) ||
    URL_CREDENTIAL_PATTERN.test(title) ||
    JWT_PATTERN.test(title) ||
    UUID_PATTERN.test(title) ||
    LONG_HEX_IDENTIFIER_PATTERN.test(title) ||
    containsPaymentCardNumber(title)
  ) {
    return "";
  }
  const opaqueCandidates = title.match(OPAQUE_IDENTIFIER_CANDIDATE_PATTERN) ?? [];
  return opaqueCandidates.some((candidate) => isOpaqueIdentifier(candidate, title)) ? "" : value;
}

function looksPrivate(value: string): boolean {
  const decoded = decodeForInspection(value);
  return (
    decoded.length > 96 ||
    /(?:^|[^A-Za-z0-9])(?:bearer|password|passwd|secret|token|credential)(?:$|[^A-Za-z0-9])/iu.test(
      decoded,
    ) ||
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/u.test(decoded) ||
    /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(decoded) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(decoded) ||
    /^\d{4,}$/u.test(decoded) ||
    (decoded.length >= 6 &&
      /^[A-Za-z0-9._~-]+$/u.test(decoded) &&
      /[A-Za-z]/u.test(decoded) &&
      /\d/u.test(decoded))
  );
}

function isSensitivePathKey(value: string): boolean {
  return value
    .toLowerCase()
    .split(/[-_]/u)
    .some((part) => SENSITIVE_PATH_KEYS.has(part));
}

function isExplicitlyStaticPathSegment(value: string): boolean {
  if (value === REDACTED_VALUE) return true;
  const normalized = value.toLowerCase();
  return SAFE_STATIC_PATH_SEGMENTS.has(normalized) || isSensitivePathKey(normalized);
}

function sanitizePathname(pathname: string): string {
  let redactNext = false;
  return pathname
    .split("/")
    .map((segment) => {
      if (segment.length === 0) return segment;
      const decoded = decodeForInspection(segment);
      const shouldRedact =
        redactNext || looksPrivate(decoded) || !isExplicitlyStaticPathSegment(decoded);
      redactNext = isSensitivePathKey(decoded);
      return shouldRedact ? REDACTED_VALUE : segment;
    })
    .join("/");
}

function isSafeQueryValue(key: string, value: string): boolean {
  if (value === REDACTED_VALUE) return true;
  if (looksPrivate(value)) return false;
  if (key === "lang" || key === "language" || key === "locale") {
    return /^[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?$/u.test(value);
  }
  if (key === "page") return /^\d{1,6}$/u.test(value);
  return SAFE_STATIC_QUERY_VALUES[key]?.has(value.toLowerCase()) ?? false;
}

function sanitizeSearchParams(searchParams: URLSearchParams): string {
  const sanitized = new URLSearchParams();
  for (const [key, value] of searchParams) {
    const normalizedKey = key.trim().toLowerCase();
    if (!SAFE_QUERY_KEYS.has(normalizedKey)) {
      continue;
    }
    sanitized.append(
      normalizedKey,
      isSafeQueryValue(normalizedKey, value) ? value : REDACTED_VALUE,
    );
  }
  return sanitized.toString();
}

/**
 * Produces the durable/public URL attached to a browser annotation.
 *
 * The full live URL may contain credentials, magic links, personal identifiers,
 * opaque tokens, or application state. It must remain an ephemeral browser
 * affinity value and never cross the annotation persistence boundary.
 */
export function sanitizeBrowserAnnotationUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return "";
    }
    const canonicalInput = url.href;
    url.username = "";
    url.password = "";
    url.pathname = sanitizePathname(url.pathname);
    url.search = sanitizeSearchParams(url.searchParams);
    url.hash = "";
    return url.href === canonicalInput ? value : url.href;
  } catch {
    return "";
  }
}

/**
 * Returns the private live URL identity used to distinguish annotation
 * documents while intentionally ignoring only the fragment. Unlike the public
 * annotation URL sanitizer, this keeps query state so unrelated private pages
 * cannot share a marker projection.
 */
export function browserAnnotationDocumentIdentityUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    url.hash = "";
    return url.href;
  } catch {
    return "";
  }
}
