const REDACTED = "[redacted]";
const SENSITIVE_FIELD_NAMES = new Set([
  "accesstoken",
  "authorizationcode",
  "clientsecret",
  "codeverifier",
  "idtoken",
  "refreshtoken",
  "state",
]);
const SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "client_secret",
  "code",
  "code_verifier",
  "id_token",
  "refresh_token",
  "state",
  "token",
]);

function isSensitiveField(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase());
}

function redactUrl(value: string): string {
  if (!/^https?:\/\//i.test(value)) return value;
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_QUERY_NAMES.has(key.toLowerCase())) {
        url.searchParams.set(key, REDACTED);
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactOutboundMcpLifecycleMetadata(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return redactUrl(current);
    if (current === null || typeof current !== "object") return current;
    if (seen.has(current)) return "[circular]";
    seen.add(current);
    if (Array.isArray(current)) return current.map(visit);
    if (current instanceof URL) return redactUrl(current.toString());
    if (current instanceof Error) {
      return { name: current.name, message: formatOutboundMcpError(current) };
    }

    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => [
        key,
        isSensitiveField(key) ? REDACTED : visit(entry),
      ]),
    );
  };
  return visit(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatOutboundMcpError(
  cause: unknown,
  sensitiveValues: ReadonlyArray<string> = [],
): string {
  let message = cause instanceof Error ? cause.message : String(cause);
  const secretsByLength = [...sensitiveValues]
    .filter(Boolean)
    .toSorted((a, b) => b.length - a.length);
  for (const secret of secretsByLength) {
    message = message.replace(new RegExp(escapeRegExp(secret), "g"), REDACTED);
  }
  message = message.replace(/https?:\/\/[^\s)]+/gi, (url) => redactUrl(url));
  message = message.replace(
    /\b(access[_-]?token|refresh[_-]?token|authorization[_-]?code|client[_-]?secret|code[_-]?verifier|id[_-]?token)\b\s*[:=]\s*[^\s,;]+/gi,
    (_match, label: string) => `${label}=${REDACTED}`,
  );
  return message;
}
