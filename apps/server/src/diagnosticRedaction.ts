const REDACTED_VALUE = "[REDACTED]";

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

const SENSITIVE_KEY_QUALIFIERS = new Set(["api", "private", "secret"]);

const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b((?:(?:proxy[-_ ]?)?authorization|api[-_ ]?key|(?:access|refresh|session)[-_ ]?token|token|password|passwd|passphrase|client[-_ ]?secret|(?:aws[-_ ]?)?secret(?:[-_ ]?(?:access[-_ ]?)?key)?|credentials?)\s*(?::|=)\s*)(?:bearer\s+)?(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu;
const BEARER_CREDENTIAL_PATTERN = /\b(bearer\s+)[A-Za-z0-9._~+/=-]+/giu;

function normalizedKey(key: string): string {
  return key.replace(/[^a-z0-9]/giu, "").toLowerCase();
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
  const normalized = normalizedKey(key);
  if (EXACT_SENSITIVE_KEYS.has(normalized)) {
    return true;
  }

  const tokens = keyTokens(key);
  const terminalToken = tokens.at(-1);
  if (terminalToken === undefined) {
    return false;
  }
  if (SENSITIVE_TERMINAL_TOKENS.has(terminalToken)) {
    return true;
  }
  return (
    terminalToken === "key" &&
    tokens.slice(0, -1).some((token) => SENSITIVE_KEY_QUALIFIERS.has(token))
  );
}

export function redactDiagnosticData(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactDiagnosticData(entry, seen));
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED_VALUE : redactDiagnosticData(entry, seen);
  }
  return redacted;
}

export function redactDiagnosticText(value: string): string {
  return value
    .replace(CREDENTIAL_ASSIGNMENT_PATTERN, `$1${REDACTED_VALUE}`)
    .replace(BEARER_CREDENTIAL_PATTERN, `$1${REDACTED_VALUE}`);
}
