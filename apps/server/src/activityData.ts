export const MAX_ACTIVITY_DATA_JSON_CHARS = 16_000;

const MAX_ACTIVITY_DATA_STRING_CHARS = 2_000;
const MAX_ACTIVITY_DATA_ARRAY_ITEMS = 24;
const MAX_ACTIVITY_DATA_OBJECT_KEYS = 64;
const ACTIVITY_DATA_TRUNCATION_MARKER = "__synaraTruncated";
const ACTIVITY_PAYLOAD_KEY_RANKS: Readonly<Record<string, number>> = {
  itemType: 0,
  status: 1,
  title: 2,
  detail: 3,
  toolName: 4,
  tool: 5,
  toolCallId: 6,
  callID: 7,
  callId: 8,
  command: 9,
  cmd: 10,
  input: 11,
  rawInput: 12,
  arguments: 13,
  args: 14,
  params: 15,
  item: 16,
  result: 17,
  rawOutput: 18,
  output: 19,
  data: 20,
  commandActions: 21,
  files: 22,
  changes: 23,
  path: 24,
  file: 25,
  filePath: 26,
  stdout: 27,
  stderr: 28,
  content: 29,
  totalFiles: 30,
  truncated: 31,
};

export function stringifyJsonLike(value: unknown): string {
  const seen = new WeakSet<object>();
  return (
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "bigint") {
        return entry.toString();
      }
      if (typeof entry === "function" || typeof entry === "symbol") {
        return undefined;
      }
      if (entry && typeof entry === "object") {
        if (seen.has(entry)) {
          return "[Circular]";
        }
        seen.add(entry);
      }
      return entry;
    }) ?? "null"
  );
}

function truncateJsonString(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, Math.max(0, limit - 15))}... [truncated]` : value;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function activityPayloadKeyRank(key: string): number {
  return ACTIVITY_PAYLOAD_KEY_RANKS[key] ?? 100;
}

type JsonTruncationOptions = {
  readonly stringLimit: number;
  readonly arrayItems: number;
  readonly objectKeys: number;
  readonly depth: number;
  readonly seen?: WeakSet<object>;
};

function truncateJsonValue(value: unknown, options: JsonTruncationOptions): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return truncateJsonString(value, options.stringLimit);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) {
    return null;
  }

  const seen = options.seen ?? new WeakSet<object>();
  if (value && typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
  }
  if (options.depth <= 0) {
    return isJsonObject(value) || Array.isArray(value)
      ? { [ACTIVITY_DATA_TRUNCATION_MARKER]: true }
      : String(value);
  }
  if (Array.isArray(value)) {
    const retained = value
      .slice(0, options.arrayItems)
      .map((entry) => truncateJsonValue(entry, { ...options, depth: options.depth - 1, seen }));
    if (value.length > options.arrayItems) {
      retained.push({
        [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
        omittedItems: value.length - options.arrayItems,
      });
    }
    return retained;
  }
  if (!isJsonObject(value)) {
    return String(value);
  }

  const entries = Object.entries(value)
    .filter(
      ([, entry]) =>
        entry !== undefined && typeof entry !== "function" && typeof entry !== "symbol",
    )
    .toSorted((left, right) => {
      const byRank = activityPayloadKeyRank(left[0]) - activityPayloadKeyRank(right[0]);
      return byRank !== 0 ? byRank : left[0].localeCompare(right[0]);
    });
  const result: Record<string, unknown> = {};
  for (const [key, entry] of entries.slice(0, options.objectKeys)) {
    result[key] = truncateJsonValue(entry, { ...options, depth: options.depth - 1, seen });
  }
  if (entries.length > options.objectKeys) {
    result[ACTIVITY_DATA_TRUNCATION_MARKER] = true;
    result.omittedKeys = entries.length - options.objectKeys;
  }
  return result;
}

function withTruncationMetadata(
  bounded: unknown,
  originalJsonChars: number,
): Record<string, unknown> {
  const metadata = {
    [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
    originalJsonChars,
  };
  return isJsonObject(bounded) ? { ...bounded, ...metadata } : { ...metadata, value: bounded };
}

export function boundActivityData(value: unknown): unknown {
  const serialized = stringifyJsonLike(value);
  if (serialized.length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return JSON.parse(serialized);
  }

  const compact = withTruncationMetadata(
    truncateJsonValue(value, {
      stringLimit: MAX_ACTIVITY_DATA_STRING_CHARS,
      arrayItems: MAX_ACTIVITY_DATA_ARRAY_ITEMS,
      objectKeys: MAX_ACTIVITY_DATA_OBJECT_KEYS,
      depth: 6,
    }),
    serialized.length,
  );
  if (stringifyJsonLike(compact).length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return compact;
  }

  const bounded = withTruncationMetadata(
    truncateJsonValue(value, {
      stringLimit: 800,
      arrayItems: 12,
      objectKeys: 32,
      depth: 4,
    }),
    serialized.length,
  );
  if (stringifyJsonLike(bounded).length <= MAX_ACTIVITY_DATA_JSON_CHARS) {
    return bounded;
  }
  return {
    [ACTIVITY_DATA_TRUNCATION_MARKER]: true,
    originalJsonChars: serialized.length,
    preview: truncateJsonString(serialized, MAX_ACTIVITY_DATA_STRING_CHARS),
  };
}

export function activityDataField(data: unknown): { readonly data?: unknown } {
  return data === undefined ? {} : { data: boundActivityData(data) };
}
