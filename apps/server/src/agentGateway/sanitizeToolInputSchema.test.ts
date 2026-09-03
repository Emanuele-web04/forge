import { assert, describe, it } from "@effect/vitest";

import { BROWSER_TOOL_CATALOGUE } from "@synara/shared/browserAutomationCatalogue";

import { sanitizeToolInputSchema } from "./sanitizeToolInputSchema.ts";
import { countSchemaKeyOccurrences, isJsonRecord } from "./schemaTestUtils.ts";

const FALLBACK_OBJECT_DESCRIPTION = "Free-form JSON object (depth 20, 256 KiB max).";

const cloneJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

const asJsonRecord = (node: unknown, label: string): Record<string, unknown> => {
  if (isJsonRecord(node)) return node;
  throw new Error(`Expected ${label} to be an object schema.`);
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

  it("inlines acyclic string, array, and enum references with their true schema", () => {
    const input = {
      type: "object",
      properties: {
        nickname: { $ref: "#/$defs/Nickname" },
        tags: { $ref: "#/$defs/TagList" },
        mode: { $ref: "#/$defs/Mode", description: "Call-site description wins." },
      },
      $defs: {
        Nickname: { type: "string", minLength: 1 },
        TagList: { type: "array", items: { type: "string" } },
        Mode: {
          type: "string",
          enum: ["fast", "careful"],
          description: "Catalogue description.",
        },
      },
    };

    const output = sanitizeToolInputSchema(cloneJson(input));

    assert.deepEqual(output, {
      type: "object",
      properties: {
        nickname: { type: "string", minLength: 1 },
        tags: { type: "array", items: { type: "string" } },
        mode: {
          type: "string",
          enum: ["fast", "careful"],
          description: "Call-site description wins.",
        },
      },
    });
  });

  it("breaks only the cyclic definitions in a mixed recursive and acyclic schema", () => {
    const input = {
      type: "object",
      properties: {
        payload: { $ref: "#/$defs/JsonValue" },
        label: { $ref: "#/$defs/Label" },
        wrapped: { $ref: "#/$defs/Wrapper" },
      },
      $defs: {
        JsonValue: {
          anyOf: [
            { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
            { type: "string" },
          ],
        },
        Label: { type: "string" },
        Wrapper: {
          type: "object",
          properties: { value: { $ref: "#/$defs/JsonValue" } },
        },
      },
    };

    const output = sanitizeToolInputSchema(cloneJson(input));

    assert.deepEqual(output, {
      type: "object",
      properties: {
        payload: { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
        label: { type: "string" },
        wrapped: {
          type: "object",
          properties: {
            value: { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
          },
        },
      },
    });
  });

  it("breaks mutual definition cycles and unresolvable references", () => {
    const input = {
      type: "object",
      properties: {
        left: { $ref: "#/$defs/Left" },
        missing: { $ref: "#/$defs/Gone" },
        external: { $ref: "https://example.com/schema.json#/$defs/Thing" },
      },
      $defs: {
        Left: { type: "object", properties: { right: { $ref: "#/$defs/Right" } } },
        Right: { type: "object", properties: { left: { $ref: "#/$defs/Left" } } },
      },
    };

    const output = sanitizeToolInputSchema(cloneJson(input));

    assert.deepEqual(output, {
      type: "object",
      properties: {
        left: { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
        missing: { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
        external: { type: "object", description: FALLBACK_OBJECT_DESCRIPTION },
      },
    });
  });
});
