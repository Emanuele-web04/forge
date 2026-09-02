import type { ProviderKind, ThreadId } from "@synara/contracts";
import { Cause, Effect } from "effect";

import { isProviderCredentialKey } from "../../providerChildEnvironment.ts";
import type { EventNdjsonLogger } from "../Layers/EventNdjsonLogger.ts";
import type {
  AcpProtocolLogEvent,
  AcpSessionRequestLogEvent,
  AcpSessionRuntimeOptions,
} from "./AcpSessionRuntime.ts";

export const ACP_LOG_REDACTED_VALUE = "[REDACTED]";

const URL_CREDENTIALS_PATTERN = /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:]*:[^/\s]+@/giu;
const QUERY_SECRET_PARAM_PATTERN =
  /([?&](?:access[-_]?token|api[-_]?key|api[-_]?token|auth|auth[-_]?token|authorization|client[-_]?secret|cookie|credential|credentials|id[-_]?token|passphrase|passwd|password|private[-_]?key|refresh[-_]?token|secret|secret[-_]?key|session[-_]?token|token)=)[^&#\s]*/giu;
const SCHEMED_CREDENTIAL_PATTERN =
  /\b(bearer|basic|digest|apikey|api[_-]?key)\s+[A-Za-z0-9._~+/=-]+/giu;
const COOKIE_HEADER_PATTERN = /\b((?:set[-_ ]?cookie|cookie)\s*:\s*)[^,\r\n]+/giu;
const JSON_KEY_VALUE_PATTERN = /("((?:\\[\s\S]|[^"\\])*)"\s*:\s*")((?:\\[\s\S]|[^"\\])*)"/giu;
const NAMED_VALUE_PATTERN =
  /("name"\s*:\s*")((?:\\[\s\S]|[^"\\])*)("\s*,\s*"value"\s*:\s*")((?:\\[\s\S]|[^"\\])*)"/giu;
const HEADER_VALUE_PATTERN =
  /\b(([A-Za-z0-9_-]+(?:\s+[A-Za-z0-9_-]+)*)\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/giu;
const ENV_ASSIGNMENT_PATTERN =
  /\b([A-Za-z0-9_.-]+)\s*=\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[^\s"',}\]]+)/gu;

const EXACT_SENSITIVE_KEYS: Record<string, true> = {
  accesskey: true,
  accesskeyid: true,
  apikey: true,
  authtoken: true,
  authorization: true,
  clientsecret: true,
  cookie: true,
  cookies: true,
  credential: true,
  credentials: true,
  idtoken: true,
  passphrase: true,
  passwd: true,
  password: true,
  privatekey: true,
  proxyauthorization: true,
  pwd: true,
  refreshtoken: true,
  secret: true,
  secretkey: true,
  sessiontoken: true,
  setcookie: true,
  token: true,
};
const SECRET_TERMINAL_WORDS: Record<string, true> = {
  authorization: true,
  cookie: true,
  cookies: true,
  credential: true,
  credentials: true,
  passphrase: true,
  passwd: true,
  password: true,
  pwd: true,
  secret: true,
  secrets: true,
};
const TOKEN_TERMINAL_WORDS: Record<string, true> = {
  token: true,
  tokens: true,
};
const SECRET_TOKEN_QUALIFIERS: Record<string, true> = {
  access: true,
  api: true,
  auth: true,
  bearer: true,
  bot: true,
  client: true,
  gateway: true,
  id: true,
  jwt: true,
  machine: true,
  oauth: true,
  personal: true,
  refresh: true,
  secret: true,
  service: true,
  session: true,
  sso: true,
  user: true,
  webhook: true,
};
const SENSITIVE_ENV_NAME_SUFFIXES = [
  "accesskeyid",
  "apikey",
  "passphrase",
  "passwd",
  "password",
  "privatekey",
  "pwd",
  "secret",
  "secretkey",
  "token",
] as const;

function keyTokens(key: string): string[] {
  return (
    key
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
      .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
      .toLowerCase()
      .match(/[a-z0-9]+/gu) ?? []
  );
}

/** True when a JSON object key names a credential rather than benign metadata. */
function isSensitiveKey(key: string): boolean {
  if (isProviderCredentialKey(key)) {
    return true;
  }
  const normalized = key.replace(/[^a-z0-9]/giu, "").toLowerCase();
  if (EXACT_SENSITIVE_KEYS[normalized]) {
    return true;
  }
  const tokens = keyTokens(key);
  const terminal = tokens.at(-1);
  if (terminal === undefined) {
    return false;
  }
  if (SECRET_TERMINAL_WORDS[terminal]) {
    return true;
  }
  if (TOKEN_TERMINAL_WORDS[terminal]) {
    // `prompt_tokens`, `total_tokens`, `completion_tokens` are usage counters, not secrets.
    const qualifier = tokens.at(-2);
    return qualifier === undefined || SECRET_TOKEN_QUALIFIERS[qualifier] === true;
  }
  return (
    terminal === "key" &&
    tokens.slice(0, -1).some((token) => ["api", "private", "proxy", "secret"].includes(token))
  );
}

/** True for environment/credential names (e.g. `AWS_SECRET_ACCESS_KEY`). */
function isSensitiveEnvName(name: string): boolean {
  if (isSensitiveKey(name)) {
    return true;
  }
  const normalized = name.replace(/[^a-z0-9]/giu, "").toLowerCase();
  return SENSITIVE_ENV_NAME_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

function jsonKeyValueReplacement(match: string, keyPrefix: string, key: string): string {
  if (!isSensitiveKey(key) || match.includes(ACP_LOG_REDACTED_VALUE)) {
    return match;
  }
  return `${keyPrefix}${ACP_LOG_REDACTED_VALUE}"`;
}

function namedValueReplacement(
  match: string,
  namePrefix: string,
  name: string,
  separator: string,
): string {
  if (!isSensitiveEnvName(name) || match.includes(ACP_LOG_REDACTED_VALUE)) {
    return match;
  }
  return `${namePrefix}${name}${separator}${ACP_LOG_REDACTED_VALUE}"`;
}

function headerValueReplacement(match: string, prefix: string, name: string): string {
  if (!isSensitiveKey(name) || match.includes(ACP_LOG_REDACTED_VALUE)) {
    return match;
  }
  return `${prefix}${ACP_LOG_REDACTED_VALUE}`;
}

function envAssignmentReplacement(match: string, name: string): string {
  if (!isSensitiveEnvName(name) || match.includes(ACP_LOG_REDACTED_VALUE)) {
    return match;
  }
  return `${name}=${ACP_LOG_REDACTED_VALUE}`;
}

function redactSecretText(value: string): string {
  return value
    .replace(URL_CREDENTIALS_PATTERN, `$1${ACP_LOG_REDACTED_VALUE}@`)
    .replace(QUERY_SECRET_PARAM_PATTERN, `$1${ACP_LOG_REDACTED_VALUE}`)
    .replace(SCHEMED_CREDENTIAL_PATTERN, `$1${ACP_LOG_REDACTED_VALUE}`)
    .replace(COOKIE_HEADER_PATTERN, `$1${ACP_LOG_REDACTED_VALUE}`)
    .replace(JSON_KEY_VALUE_PATTERN, jsonKeyValueReplacement)
    .replace(NAMED_VALUE_PATTERN, namedValueReplacement)
    .replace(HEADER_VALUE_PATTERN, headerValueReplacement)
    .replace(ENV_ASSIGNMENT_PATTERN, envAssignmentReplacement);
}

function redactJsonDocument(value: string, seen: WeakMap<object, unknown>): string | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    const redacted = visit(parsed, seen);
    const originalSerialized = JSON.stringify(parsed);
    const redactedSerialized = JSON.stringify(redacted);
    if (redactedSerialized === originalSerialized) {
      return null;
    }
    return redactedSerialized;
  } catch {
    return null;
  }
}

function redactSecretString(value: string, seen: WeakMap<object, unknown>): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const redactedJson = redactJsonDocument(value, seen);
    if (redactedJson !== null) {
      return redactedJson;
    }
  }
  return redactSecretText(value);
}

function visit(current: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof current === "string") {
    return redactSecretString(current, seen);
  }
  if (current instanceof Uint8Array) {
    return redactSecretString(new TextDecoder().decode(current), seen);
  }
  if (current === null || typeof current !== "object") {
    return current;
  }
  const existing = seen.get(current);
  if (existing !== undefined) {
    return existing;
  }
  if (current instanceof Date) {
    const result = Number.isNaN(current.getTime()) ? String(current) : current.toISOString();
    seen.set(current, result);
    return result;
  }
  if (current instanceof URL) {
    const result = redactSecretString(current.toString(), seen);
    seen.set(current, result);
    return result;
  }
  if (current instanceof Error) {
    const clone: Record<string, unknown> = {};
    seen.set(current, clone);
    clone.name = current.name;
    clone.message = visit(current.message, seen);
    if (current.stack !== undefined) {
      clone.stack = visit(current.stack, seen);
    }
    for (const [key, entry] of Object.entries(current)) {
      clone[key] = visit(entry, seen);
    }
    return clone;
  }
  if (Array.isArray(current)) {
    const clone: unknown[] = [];
    seen.set(current, clone);
    for (const entry of current) {
      clone.push(visit(entry, seen));
    }
    return clone;
  }

  // Covers plain objects, null-prototype objects, and custom-prototype instances.
  const source = current as Record<string, unknown>;
  const clone: Record<string, unknown> = {};
  seen.set(current, clone);
  const namedEntry = typeof source.name === "string" ? source.name : undefined;
  for (const [key, entry] of Object.entries(source)) {
    if (
      isSensitiveKey(key) ||
      (key.toLowerCase() === "value" && namedEntry !== undefined && isSensitiveEnvName(namedEntry))
    ) {
      clone[key] = ACP_LOG_REDACTED_VALUE;
    } else {
      clone[key] = visit(entry, seen);
    }
  }
  return clone;
}

/** Recursively sanitize both decoded ACP payloads and raw JSON protocol frames. */
export function redactAcpLogSecrets(value: unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  return visit(value, seen);
}

function writeNativeAcpLog(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly kind: "request" | "protocol";
  readonly payload: unknown;
}): Effect.Effect<void, never> {
  return Effect.gen(function* () {
    if (!input.nativeEventLogger) return;
    const observedAt = new Date().toISOString();
    yield* input.nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: crypto.randomUUID(),
          kind: input.kind,
          provider: input.provider,
          createdAt: observedAt,
          threadId: input.threadId,
          payload: redactAcpLogSecrets(input.payload),
        },
      },
      input.threadId,
    );
  });
}

function formatRequestLogPayload(event: AcpSessionRequestLogEvent) {
  return {
    method: event.method,
    status: event.status,
    request: event.payload,
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.cause !== undefined ? { cause: redactAcpLogSecrets(Cause.pretty(event.cause)) } : {}),
  };
}

function stringifyAcpLogPayload(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload instanceof Uint8Array) return new TextDecoder().decode(payload);
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

export function summarizeAcpLogPayload(payload: unknown, limit: number): string {
  const text = stringifyAcpLogPayload(payload);
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}... [truncated ${text.length - limit} chars]`;
}

export function makeAcpDebugLoggers(input: {
  readonly base: Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">;
  readonly enabled: boolean;
  readonly provider: ProviderKind;
  readonly marker: string;
  readonly payloadLimit: number;
  readonly shouldMirrorIncomingRaw: (payload: string) => boolean;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  const summarize = (payload: unknown) =>
    summarizeAcpLogPayload(redactAcpLogSecrets(payload), input.payloadLimit);
  const requestLogger: AcpSessionRuntimeOptions["requestLogger"] =
    input.base.requestLogger || input.enabled
      ? (event) =>
          Effect.gen(function* () {
            if (input.base.requestLogger) yield* input.base.requestLogger(event);
            if (input.enabled && event.status === "failed") {
              yield* Effect.logWarning(`${input.provider}.acp.request_failed`, {
                marker: input.marker,
                method: event.method,
                payload:
                  event.method === "session/prompt"
                    ? "[redacted session/prompt payload]"
                    : summarize(event.payload),
                cause: event.cause ? redactAcpLogSecrets(Cause.pretty(event.cause)) : undefined,
              });
            }
          })
      : undefined;
  const protocolLogging: AcpSessionRuntimeOptions["protocolLogging"] =
    input.base.protocolLogging || input.enabled
      ? {
          logIncoming: input.base.protocolLogging?.logIncoming ?? input.enabled,
          logOutgoing: input.base.protocolLogging?.logOutgoing ?? false,
          logger: (event) =>
            Effect.gen(function* () {
              if (input.base.protocolLogging?.logger) {
                yield* input.base.protocolLogging.logger(event);
              }
              const payload = summarize(event.payload);
              if (
                !input.enabled ||
                event.direction !== "incoming" ||
                event.stage !== "raw" ||
                !input.shouldMirrorIncomingRaw(payload)
              ) {
                return;
              }
              yield* Effect.logWarning(`${input.provider}.acp.protocol`, {
                marker: input.marker,
                direction: event.direction,
                stage: event.stage,
                payload,
              });
            }),
        }
      : undefined;

  return {
    ...(requestLogger ? { requestLogger } : {}),
    ...(protocolLogging ? { protocolLogging } : {}),
  };
}

export function makeAcpNativeLoggers(input: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
}): Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging"> {
  return {
    requestLogger: (event) =>
      writeNativeAcpLog({
        nativeEventLogger: input.nativeEventLogger,
        provider: input.provider,
        threadId: input.threadId,
        kind: "request",
        payload: formatRequestLogPayload(event),
      }),
    ...(input.nativeEventLogger
      ? {
          protocolLogging: {
            logIncoming: true,
            logOutgoing: true,
            logger: (event: AcpProtocolLogEvent) =>
              writeNativeAcpLog({
                nativeEventLogger: input.nativeEventLogger,
                provider: input.provider,
                threadId: input.threadId,
                kind: "protocol",
                payload: event,
              }),
          } satisfies NonNullable<AcpSessionRuntimeOptions["protocolLogging"]>,
        }
      : {}),
  };
}
