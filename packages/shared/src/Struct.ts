export type DeepPartial<T> = T extends readonly (infer Item)[]
  ? readonly DeepPartial<Item>[]
  : T extends object
    ? { readonly [Key in keyof T]?: DeepPartial<T[Key]> }
    : T;

const PROTOTYPE_MUTATION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (!isPlainRecord(base) || !isPlainRecord(patch)) {
    return patch as T;
  }

  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || PROTOTYPE_MUTATION_KEYS.has(key)) {
      continue;
    }
    const current = next[key];
    next[key] = isPlainRecord(current) && isPlainRecord(value) ? deepMerge(current, value) : value;
  }
  return next as T;
}
