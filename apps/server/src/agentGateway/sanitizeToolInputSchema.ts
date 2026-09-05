/**
 * Console Go rejects recursive tool `inputSchema` schemas (400
 * "Recursive JSON schemas are not currently supported"). Only
 * `browser_webmcp_call.arguments` (Schema.Json) emits `$ref` cycles today.
 *
 * Acyclic local references are inlined with their true schema so clients
 * keep generating valid arguments. Only references that participate in a
 * `$defs` cycle (or point nowhere resolvable) become a permissive
 * free-form object. Runtime validation stays server-side (Effect decode,
 * depth 20 / 256 KiB).
 */
export const FALLBACK_OBJECT_DESCRIPTION = "Free-form JSON object (depth 20, 256 KiB max).";
const DEFS_PREFIX = "#/$defs/";

const isRecord = (node: unknown): node is Record<string, unknown> =>
  node !== null && typeof node === "object" && !Array.isArray(node);

/** Exact local pointer `#/$defs/<Name>`; anything else is not resolvable here. */
const defNameOf = (ref: string): string | undefined => {
  if (!ref.startsWith(DEFS_PREFIX)) return undefined;
  const rest = ref.slice(DEFS_PREFIX.length);
  if (rest.length === 0 || rest.includes("/")) return undefined;
  return rest;
};

const cloneJsonRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value));

/** Every `#/$defs/<Name>` target reachable inside a subtree. */
const collectRefTargets = (node: unknown, into: Set<string>): void => {
  if (Array.isArray(node)) {
    for (const child of node) collectRefTargets(child, into);
    return;
  }
  if (!isRecord(node)) return;
  if (typeof node.$ref === "string") {
    const target = defNameOf(node.$ref);
    if (target !== undefined) into.add(target);
  }
  for (const value of Object.values(node)) collectRefTargets(value, into);
};

/** `$defs` entries that can reach themselves through local references. */
const findRecursiveDefNames = (defs: Record<string, unknown>): ReadonlySet<string> => {
  const edges = new Map<string, ReadonlySet<string>>();
  for (const [name, body] of Object.entries(defs)) {
    const targets = new Set<string>();
    collectRefTargets(body, targets);
    edges.set(name, targets);
  }
  const recursive = new Set<string>();
  for (const name of edges.keys()) {
    const stack = [...(edges.get(name) ?? [])];
    const seen = new Set<string>();
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      if (next === name) {
        recursive.add(name);
        break;
      }
      if (seen.has(next)) continue;
      seen.add(next);
      for (const follow of edges.get(next) ?? []) stack.push(follow);
    }
  }
  return recursive;
};

const fallbackObject = (node: Record<string, unknown>): Record<string, unknown> => ({
  type: "object",
  description:
    typeof node.description === "string" ? node.description : FALLBACK_OBJECT_DESCRIPTION,
});

interface SanitizeState {
  readonly defs: Record<string, unknown>;
  readonly recursive: ReadonlySet<string>;
}

const sanitizeNode = (node: unknown, state: SanitizeState): unknown => {
  if (Array.isArray(node)) return node.map((child) => sanitizeNode(child, state));
  if (!isRecord(node)) return node;
  if (typeof node.$ref === "string") {
    const target = defNameOf(node.$ref);
    const body = target === undefined ? undefined : state.defs[target];
    if (target === undefined || !isRecord(body) || state.recursive.has(target)) {
      return fallbackObject(node);
    }
    const siblings: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key !== "$ref") siblings[key] = sanitizeNode(value, state);
    }
    const merged: Record<string, unknown> = {
      ...cloneJsonRecord(body),
      ...siblings,
    };
    return sanitizeNode(merged, state);
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$defs") continue;
    out[key] = sanitizeNode(value, state);
  }
  return out;
};

export function sanitizeToolInputSchema(schema: unknown): unknown {
  const defs = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : {};
  return sanitizeNode(schema, { defs, recursive: findRecursiveDefNames(defs) });
}
