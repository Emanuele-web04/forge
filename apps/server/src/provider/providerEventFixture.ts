const PROVIDER_EVENT_FIXTURE_VERSION = 1 as const;
const DEFAULT_MAX_FIXTURE_BYTES = 512 * 1024;
const DEFAULT_MAX_FIXTURE_EVENTS = 2_000;

const REDACTED_VALUE = "<redacted>";
const NORMALIZED_ISO_TIMESTAMP = "2000-01-01T00:00:00.000Z";

const SENSITIVE_VALUE_KEYS = new Set([
  "authorization",
  "bearer",
  "body",
  "content",
  "cookie",
  "credential",
  "cwd",
  "environment",
  "env",
  "file",
  "filePath",
  "header",
  "headers",
  "input",
  "message",
  "output",
  "path",
  "prompt",
  "secret",
  "text",
  "token",
  "url",
  "apiKey",
  "api_key",
  "attachment",
]);
const IDENTIFIER_KEY_PATTERN = /(?:^|_)(?:id|uuid)$/i;
const CAMEL_IDENTIFIER_KEY_PATTERN = /(?:Id|ID|Uuid|UUID)$/;
const TIMESTAMP_KEY_PATTERN =
  /(?:timestamp|createdAt|updatedAt|observedAt|startedAt|endedAt|time)$/i;
const OPENCODE_TOKEN_COUNTER_KEYS = new Set(["input", "output", "reasoning"]);
const OPENCODE_CACHE_COUNTER_KEYS = new Set(["read", "write"]);

// Root protocol discriminators are part of the fixture replay contract. Keep this
// allowlist explicit so a user-controlled path or label cannot cross the safe-to-commit
// boundary merely because it resembles an event name.
const SAFE_ROOT_TYPE_VALUES = new Set([
  "custom.event",
  "message.part.delta",
  "message.part.updated",
  "message.updated",
  "process/stderr",
  "session.state.changed",
  "stream_event",
  "thread/tokenUsage/updated",
  "turn.completed",
]);
const SAFE_ROOT_METHOD_VALUES = new Set(["thread/started"]);

const SAFE_STRING_KEYS = new Set([
  "type",
  "provider",
  "source",
  "method",
  "role",
  "status",
  "state",
  "finish",
  "permission",
  "reply",
  "action",
  "kind",
  "phase",
  "streamKind",
  "subtype",
]);

const SAFE_UNTRUSTED_STRING_VALUES = new Set([
  "accepted",
  "allow",
  "always",
  "approved",
  "assistant",
  "assistant_text",
  "antigravity",
  "cancelled",
  "canceled",
  "claudeAgent",
  "client",
  "codex",
  "complete",
  "completed",
  "cursor",
  "denied",
  "deny",
  "desktop",
  "droid",
  "error",
  "failed",
  "grok",
  "idle",
  "in_progress",
  "inProgress",
  "input_text",
  "kilo",
  "once",
  "output_text",
  "opencode",
  "pending",
  "pi",
  "provider",
  "ready",
  "reasoning",
  "reasoning_text",
  "rejected",
  "result",
  "running",
  "started",
  "stderr",
  "stdout",
  "stopped",
  "success",
  "server",
  "system",
  "terminal",
  "text",
  "tool",
  "user",
  "web",
]);

const SAFE_SCALAR_KEYS = new Set([
  "code",
  "sequence",
  "count",
  "total",
  "attempt",
  "retryCount",
  "durationMs",
  "enabled",
  "completed",
  "synthetic",
  "ignored",
  "is_error",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "contextWindow",
]);

const SAFE_CONTAINER_KEYS = new Set([
  "event",
  "properties",
  "payload",
  "params",
  "info",
  "part",
  "raw",
  "data",
  "metadata",
  "message",
  "item",
  "session",
  "request",
  "response",
  "result",
  "error",
  "usage",
  "cache",
  "tokens",
  "tokenUsage",
  "time",
]);

const UNTRUSTED_STRING_CONTAINER_KEYS = new Set(SAFE_CONTAINER_KEYS);

export interface ProviderEventFixtureRecord {
  readonly version: typeof PROVIDER_EVENT_FIXTURE_VERSION;
  readonly index: number;
  readonly event: unknown;
}

export interface ProviderEventFixtureParseOptions {
  readonly maxBytes?: number;
  readonly maxEvents?: number;
}

export class ProviderEventFixtureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEventFixtureError";
  }
}

type SanitizerState = {
  readonly ids: Map<string, string>;
  nextId: number;
};

type SanitizerContext = {
  readonly untrustedStrings: boolean;
  readonly openCodeTokenLocation: "none" | "tokens" | "cache";
};

function redactIdentifier(value: unknown, state: SanitizerState): string {
  if (typeof value !== "string" && typeof value !== "number") {
    throw new ProviderEventFixtureError("Identifier fields must be strings or numbers.");
  }
  const mapKey = `${typeof value}:${String(value)}`;
  const existing = state.ids.get(mapKey);
  if (existing) {
    return existing;
  }
  const replacement = `<id-${String(state.nextId)}>`;
  state.nextId += 1;
  state.ids.set(mapKey, replacement);
  return replacement;
}

function normalizeTimestamp(value: unknown): string | number {
  if (typeof value === "string") {
    return NORMALIZED_ISO_TIMESTAMP;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return 0;
  }
  throw new ProviderEventFixtureError("Timestamp fields must be strings or finite numbers.");
}

function isClassifiedFixtureKey(key: string, context: SanitizerContext): boolean {
  return (
    (context.openCodeTokenLocation === "tokens" && OPENCODE_TOKEN_COUNTER_KEYS.has(key)) ||
    (context.openCodeTokenLocation === "cache" && OPENCODE_CACHE_COUNTER_KEYS.has(key)) ||
    SAFE_CONTAINER_KEYS.has(key) ||
    SAFE_STRING_KEYS.has(key) ||
    SAFE_SCALAR_KEYS.has(key) ||
    SENSITIVE_VALUE_KEYS.has(key) ||
    IDENTIFIER_KEY_PATTERN.test(key) ||
    CAMEL_IDENTIFIER_KEY_PATTERN.test(key) ||
    TIMESTAMP_KEY_PATTERN.test(key)
  );
}

function sanitizeValue(
  value: unknown,
  key: string | null,
  state: SanitizerState,
  context: SanitizerContext,
): unknown {
  if (key && SENSITIVE_VALUE_KEYS.has(key)) {
    const isOpenCodeTokenCounter =
      context.openCodeTokenLocation === "tokens" &&
      OPENCODE_TOKEN_COUNTER_KEYS.has(key) &&
      typeof value === "number";
    const isStructuredMessage =
      key === "message" && value !== null && typeof value === "object" && !Array.isArray(value);
    if (!isStructuredMessage && !isOpenCodeTokenCounter) {
      return REDACTED_VALUE;
    }
  }
  if (key && (IDENTIFIER_KEY_PATTERN.test(key) || CAMEL_IDENTIFIER_KEY_PATTERN.test(key))) {
    if (value === null) {
      return null;
    }
    return redactIdentifier(value, state);
  }
  if (
    key &&
    TIMESTAMP_KEY_PATTERN.test(key) &&
    (typeof value === "string" || typeof value === "number")
  ) {
    return normalizeTimestamp(value);
  }

  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ProviderEventFixtureError("Fixture numbers must be finite.");
    }
    return value;
  }
  if (typeof value === "string") {
    if (
      key &&
      SAFE_STRING_KEYS.has(key) &&
      ((!context.untrustedStrings &&
        ((key === "type" && SAFE_ROOT_TYPE_VALUES.has(value)) ||
          (key === "method" && SAFE_ROOT_METHOD_VALUES.has(value)))) ||
        SAFE_UNTRUSTED_STRING_VALUES.has(value))
    ) {
      return value;
    }
    throw new ProviderEventFixtureError(
      `Refusing to preserve unclassified string field${key ? ` "${key}"` : ""}.`,
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, null, state, context));
  }
  if (typeof value !== "object") {
    throw new ProviderEventFixtureError("Fixture values must be JSON-compatible.");
  }

  const result = Object.create(null) as Record<string, unknown>;
  const childContext: SanitizerContext = {
    untrustedStrings: context.untrustedStrings,
    openCodeTokenLocation:
      key === "tokens"
        ? "tokens"
        : key === "cache" && context.openCodeTokenLocation === "tokens"
          ? "cache"
          : "none",
  };
  for (const [childKey, childValue] of Object.entries(value)) {
    if (!isClassifiedFixtureKey(childKey, childContext)) {
      throw new ProviderEventFixtureError(
        `Refusing to preserve unclassified object key "${childKey}".`,
      );
    }
    result[childKey] = sanitizeValue(childValue, childKey, state, {
      untrustedStrings: context.untrustedStrings || UNTRUSTED_STRING_CONTAINER_KEYS.has(childKey),
      openCodeTokenLocation: childContext.openCodeTokenLocation,
    });
  }
  return result;
}

export function sanitizeProviderEventFixtureEvents(events: readonly unknown[]): unknown[] {
  const state: SanitizerState = { ids: new Map(), nextId: 1 };
  return events.map((event) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new ProviderEventFixtureError("Fixture events must be objects.");
    }
    return sanitizeValue(event, null, state, {
      untrustedStrings: false,
      openCodeTokenLocation: "none",
    });
  });
}

export function serializeProviderEventFixture(events: readonly unknown[]): string {
  if (events.length > DEFAULT_MAX_FIXTURE_EVENTS) {
    throw new ProviderEventFixtureError(
      `Fixture exceeds ${String(DEFAULT_MAX_FIXTURE_EVENTS)} events.`,
    );
  }
  const serialized = sanitizeProviderEventFixtureEvents(events)
    .map((event, index) =>
      JSON.stringify({
        version: PROVIDER_EVENT_FIXTURE_VERSION,
        index,
        event,
      } satisfies ProviderEventFixtureRecord),
    )
    .join("\n");
  if (Buffer.byteLength(serialized, "utf8") > DEFAULT_MAX_FIXTURE_BYTES) {
    throw new ProviderEventFixtureError(
      `Fixture exceeds ${String(DEFAULT_MAX_FIXTURE_BYTES)} bytes.`,
    );
  }
  return serialized;
}

function parseFixtureRecord(line: string, expectedIndex: number): ProviderEventFixtureRecord {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (cause) {
    throw new ProviderEventFixtureError(
      `Fixture record ${String(expectedIndex)} is not valid JSON: ${String(cause)}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderEventFixtureError(
      `Fixture record ${String(expectedIndex)} must be an object.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (record.version !== PROVIDER_EVENT_FIXTURE_VERSION) {
    throw new ProviderEventFixtureError(
      `Fixture record ${String(expectedIndex)} has unsupported version ${String(record.version)}.`,
    );
  }
  if (record.index !== expectedIndex) {
    throw new ProviderEventFixtureError(
      `Fixture record ${String(expectedIndex)} has out-of-order index ${String(record.index)}.`,
    );
  }
  if (!record.event || typeof record.event !== "object" || Array.isArray(record.event)) {
    throw new ProviderEventFixtureError(
      `Fixture record ${String(expectedIndex)} event must be an object.`,
    );
  }
  return {
    version: PROVIDER_EVENT_FIXTURE_VERSION,
    index: expectedIndex,
    event: record.event,
  };
}

export function parseProviderEventFixture(
  text: string,
  options: ProviderEventFixtureParseOptions = {},
): ProviderEventFixtureRecord[] {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FIXTURE_BYTES;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_FIXTURE_EVENTS;
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new ProviderEventFixtureError(`Fixture exceeds ${String(maxBytes)} bytes.`);
  }

  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length > maxEvents) {
    throw new ProviderEventFixtureError(`Fixture exceeds ${String(maxEvents)} events.`);
  }
  return lines.map((line, index) => parseFixtureRecord(line, index));
}

export async function replayProviderEventFixture(
  records: readonly ProviderEventFixtureRecord[],
  consume: (event: unknown, index: number) => void | Promise<void>,
): Promise<void> {
  for (const record of records) {
    await consume(record.event, record.index);
  }
}
