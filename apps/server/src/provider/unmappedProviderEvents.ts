import type { ProviderEvent } from "@synara/contracts";

export const MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS = 16_000;

const MAX_UNMAPPED_PROVIDER_DETAIL_CHARS = 500;
const MAX_UNMAPPED_PROVIDER_NATIVE_TYPE_CHARS = 200;
const MAX_UNMAPPED_PROVIDER_PREVIEW_CHARS = 2_000;
const REDACTED_VALUE = "[REDACTED]";
const BURST_METHOD_SUFFIX = /(?:delta|progress|partial|chunk|update|updated)$/iu;
const COOKIE_HEADER_PATTERN = /\b((?:set[-_ ]?cookie|cookie)\s*:\s*)[^\r\n]+/giu;
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b((?:(?:proxy[-_ ]?)?authorization|api[-_ ]?key|private[-_ ]?key|(?:set[-_ ]?)?cookie|(?:access|refresh|session)[-_ ]?token|token|password|passwd|passphrase|client[-_ ]?secret|(?:aws[-_ ]?)?secret(?:[-_ ]?(?:access[-_ ]?)?key)?|credentials?)\s*(?::|=)\s*)(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu;
const EXACT_SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "apikey",
  "password",
  "passphrase",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "privatekey",
]);
const SENSITIVE_TERMINAL_TOKENS = new Set([
  "authorization",
  "cookie",
  "credential",
  "credentials",
  "passphrase",
  "password",
  "secret",
  "token",
]);

function redactText(value: string): string {
  return value
    .replace(COOKIE_HEADER_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}`);
}

function sanitizeText(value: string, maxChars: number): string {
  const redacted = redactText(value);
  return redacted.length <= maxChars
    ? redacted
    : `${redacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

function keyTokens(key: string): ReadonlyArray<string> {
  return (
    key
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }
  const tokens = keyTokens(key);
  const terminal = tokens.at(-1);
  return (
    terminal !== undefined &&
    (SENSITIVE_TERMINAL_TOKENS.has(terminal) ||
      (terminal === "key" &&
        tokens.slice(0, -1).some((token) => ["api", "private", "secret"].includes(token))))
  );
}

function redactValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactText(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || typeof value === "boolean") return value;
  if (typeof value !== "object") return null;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, seen));

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactValue(entry, seen);
  }
  return redacted;
}

export function sanitizeUnmappedProviderData(value: unknown): unknown {
  const redacted = redactValue(value);
  const serialized = JSON.stringify(redacted) ?? "null";
  if (serialized.length <= MAX_UNMAPPED_PROVIDER_DATA_JSON_CHARS) {
    return redacted;
  }
  return {
    __synaraTruncated: true,
    originalJsonChars: serialized.length,
    preview: `${serialized.slice(0, MAX_UNMAPPED_PROVIDER_PREVIEW_CHARS - 3)}...`,
  };
}

export function sanitizeUnmappedProviderDetail(value: string | undefined): string | undefined {
  return value === undefined ? undefined : sanitizeText(value, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS);
}

export function sanitizeUnmappedProviderNativeType(value: string): string {
  return sanitizeText(value, MAX_UNMAPPED_PROVIDER_NATIVE_TYPE_CHARS);
}

export function sanitizeUnmappedProviderEvent(event: ProviderEvent): ProviderEvent {
  return {
    ...event,
    method: sanitizeUnmappedProviderNativeType(event.method),
    ...(event.message !== undefined
      ? { message: sanitizeText(event.message, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS) }
      : {}),
    ...(event.textDelta !== undefined
      ? { textDelta: sanitizeText(event.textDelta, MAX_UNMAPPED_PROVIDER_DETAIL_CHARS) }
      : {}),
    ...(event.payload !== undefined
      ? { payload: sanitizeUnmappedProviderData(event.payload) }
      : {}),
  };
}

export function makeUnmappedProviderEventGate(maxTrackedBursts = 128) {
  const surfacedBursts = new Set<string>();
  return (event: ProviderEvent): boolean => {
    if (!BURST_METHOD_SUFFIX.test(event.method)) return true;
    const generation = event.lifecycleGeneration?.slice(0, 200) ?? "session";
    const key = `${event.threadId}\u0000${generation}\u0000${sanitizeUnmappedProviderNativeType(event.method)}`;
    if (surfacedBursts.has(key)) return false;
    if (surfacedBursts.size >= Math.max(1, maxTrackedBursts)) {
      const oldest = surfacedBursts.values().next().value;
      if (oldest !== undefined) surfacedBursts.delete(oldest);
    }
    surfacedBursts.add(key);
    return true;
  };
}
