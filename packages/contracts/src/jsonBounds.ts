const utf8Encoder = new TextEncoder();

export const jsonDepth = (value: unknown, depth = 0): number => {
  if (value === null || typeof value !== "object") return depth;
  if (depth > 20) return depth;
  if (Array.isArray(value)) {
    return value.reduce((maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)), depth);
  }
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (maximum, item) => Math.max(maximum, jsonDepth(item, depth + 1)),
    depth,
  );
};

export const jsonBytes = (value: unknown): number => {
  try {
    return utf8Encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};
