/** Shared predicates for the agent-gateway schema test suites. */

export const isJsonRecord = (node: unknown): node is Record<string, unknown> =>
  node !== null && typeof node === "object" && !Array.isArray(node);

/** Counts every occurrence of an object key anywhere inside a JSON value. */
export const countSchemaKeyOccurrences = (node: unknown, key: string): number => {
  if (Array.isArray(node)) {
    return node.reduce<number>((total, child) => total + countSchemaKeyOccurrences(child, key), 0);
  }
  if (!isJsonRecord(node)) return 0;
  return Object.entries(node).reduce<number>(
    (total, [childKey, child]) =>
      total + (childKey === key ? 1 : 0) + countSchemaKeyOccurrences(child, key),
    0,
  );
};
