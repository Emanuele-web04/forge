/**
 * Console Go rejects recursive tool `inputSchema` schemas (400
 * "Recursive JSON schemas are not currently supported"). Only
 * `browser_webmcp_call.arguments` (Schema.Json) emits `$ref` cycles today,
 * but sanitize every gateway tool so all providers (Pi, OpenCode, MCP
 * consumers) fail safe. Runtime validation stays server-side (Effect
 * decode, depth 20 / 256 KiB).
 */
export function sanitizeToolInputSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitizeToolInputSchema);
  if (schema !== null && typeof schema === "object") {
    const record = schema as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      return {
        type: "object",
        description:
          typeof record.description === "string"
            ? record.description
            : "Free-form JSON object (depth 20, 256 KiB max).",
      };
    }
    return Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => key !== "$defs")
        .map(([key, value]) => [key, sanitizeToolInputSchema(value)]),
    );
  }
  return schema;
}
