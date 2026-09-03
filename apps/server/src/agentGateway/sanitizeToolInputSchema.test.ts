import { assert, describe, it } from "@effect/vitest";

import { BROWSER_TOOL_CATALOGUE } from "@synara/shared/browserAutomationCatalogue";

import { sanitizeToolInputSchema } from "./sanitizeToolInputSchema.ts";

const FALLBACK_OBJECT_DESCRIPTION = "Free-form JSON object (depth 20, 256 KiB max).";

const cloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const isJsonRecord = (node: unknown): node is Record<string, unknown> =>
  node !== null && typeof node === "object" && !Array.isArray(node);

const asJsonRecord = (node: unknown, label: string): Record<string, unknown> => {
  if (isJsonRecord(node)) return node;
  throw new Error(`Expected ${label} to be an object schema.`);
};

const countSchemaKeyOccurrences = (node: unknown, key: string): number => {
  if (Array.isArray(node)) {
    return node.reduce<number>((total, child) => total + countSchemaKeyOccurrences(child, key), 0);
  }
  if (isJsonRecord(node)) {
    return Object.entries(node).reduce<number>(
      (total, [entryKey, child]) =>
        total + (entryKey === key ? 1 : 0) + countSchemaKeyOccurrences(child, key),
      0,
    );
  }
  return 0;
};

const findCatalogueEntryOrThrow = (name: string) => {
  const entry = BROWSER_TOOL_CATALOGUE.find((candidate) => candidate.name === name);
  if (entry === undefined) {
    throw new Error(`Expected the browser catalogue to define ${name}.`);
  }
  return entry;
};

// Mirrors the real browser_webmcp_call inputSchema: an `arguments` property
// with a $ref cycle plus a $defs block, beside plain sibling properties.
const mirroredRecursiveWebmcpSchema = () => ({
  type: "object",
  properties: {
    discoveryId: {
      type: "string",
      description: "Opaque discovery id returned by browser_webmcp_tools for the current document.",
    },
    toolId: {
      type: "string",
      description:
        "Opaque tool id returned by browser_webmcp_tools; never substitute the page tool name.",
    },
    arguments: {
      description: "Free-form page tool arguments.",
      $ref: "#/$defs/JsonValue",
    },
    filters: {
      type: "array",
      description: "Optional structured filters.",
      items: { $ref: "#/$defs/JsonValue" },
    },
  },
  required: ["discoveryId", "toolId"],
  $defs: {
    JsonValue: {
      anyOf: [{ type: "string" }, { type: "array", items: { $ref: "#/$defs/JsonValue" } }],
    },
  },
});

describe("sanitizeToolInputSchema", () => {
  it("replaces a mirrored recursive webmcp shape while keeping sibling descriptions", () => {
    const input = mirroredRecursiveWebmcpSchema();
    const inputBefore = JSON.stringify(input);

    const output = asJsonRecord(sanitizeToolInputSchema(input), "sanitized schema");

    assert.equal(countSchemaKeyOccurrences(output, "$ref"), 0);
    assert.equal(countSchemaKeyOccurrences(output, "$defs"), 0);

    const properties = asJsonRecord(output.properties, "sanitized properties");
    assert.deepEqual(properties.discoveryId, input.properties.discoveryId);
    assert.deepEqual(properties.toolId, input.properties.toolId);
    assert.deepEqual(properties.arguments, {
      type: "object",
      description: "Free-form page tool arguments.",
    });
    const filters = asJsonRecord(properties.filters, "sanitized filters");
    assert.equal(filters.description, "Optional structured filters.");
    assert.deepEqual(filters.items, {
      type: "object",
      description: FALLBACK_OBJECT_DESCRIPTION,
    });
    if (!Array.isArray(output.required)) {
      throw new Error("Expected the sanitized schema to keep its required list.");
    }
    assert.sameMembers(output.required, ["discoveryId", "toolId"]);
    assert.equal(JSON.stringify(input), inputBefore);
  });

  it("strips $ref and $defs from the real browser_webmcp_call inputSchema", () => {
    const entry = findCatalogueEntryOrThrow("browser_webmcp_call");
    assert.isAbove(countSchemaKeyOccurrences(entry.inputSchema, "$ref"), 0);
    assert.isAbove(countSchemaKeyOccurrences(entry.inputSchema, "$defs"), 0);

    const input = cloneJson(entry.inputSchema);
    const output = asJsonRecord(sanitizeToolInputSchema(input), "sanitized webmcp schema");

    assert.equal(countSchemaKeyOccurrences(output, "$ref"), 0);
    assert.equal(countSchemaKeyOccurrences(output, "$defs"), 0);

    const outputProperties = asJsonRecord(output.properties, "sanitized webmcp properties");
    const inputProperties = asJsonRecord(
      asJsonRecord(input, "cloned webmcp schema").properties,
      "cloned webmcp properties",
    );
    for (const propertyName of Object.keys(inputProperties)) {
      if (propertyName === "arguments") continue;
      assert.deepEqual(outputProperties[propertyName], inputProperties[propertyName]);
    }
    assert.include(JSON.stringify(outputProperties.toolId), "never substitute the page tool name");
    if (!Array.isArray(output.required)) {
      throw new Error("Expected the sanitized webmcp schema to keep its required list.");
    }
    assert.sameMembers(output.required, ["discoveryId", "toolId"]);
  });

  it("passes unrelated schemas through byte-identical", () => {
    const input: Record<string, unknown> = {
      type: "object",
      properties: {
        limit: { type: "integer", minimum: 1, maximum: 32, default: 8 },
        tabId: { type: "string", description: "Optional scoped tab." },
      },
      required: [],
      additionalProperties: false,
    };
    const inputBefore = JSON.stringify(input);

    const output = sanitizeToolInputSchema(input);

    assert.deepEqual(output, input);
    assert.equal(JSON.stringify(output), inputBefore);
    assert.equal(JSON.stringify(input), inputBefore);
  });

  it("leaves primitives untouched and sanitizes $refs inside arrays", () => {
    assert.strictEqual(sanitizeToolInputSchema("free-form"), "free-form");
    assert.strictEqual(sanitizeToolInputSchema(32), 32);
    assert.strictEqual(sanitizeToolInputSchema(null), null);
    assert.deepEqual(sanitizeToolInputSchema([{ $ref: "#/$defs/JsonValue" }, { type: "string" }]), [
      { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
      { type: "string" },
    ]);
  });
});
