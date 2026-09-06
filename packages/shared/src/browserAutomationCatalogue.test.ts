import { BROWSER_TOOL_NAMES, utf8ByteLength } from "@synara/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  BROWSER_TOOL_CATALOGUE,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITIONS_BY_NAME,
  DESTRUCTIVE_LOCAL,
  DESTRUCTIVE_OPEN_WORLD,
  IDEMPOTENT_LOCAL,
  MUTATING_OPEN_WORLD,
  READ_ONLY_LOCAL,
  READ_ONLY_OPEN_WORLD,
  stableJsonStringify,
  projectBrowserToolDefinitions,
  compactToolInputSchema,
} from "./browserAutomationCatalogue";

describe("browser automation catalogue projection", () => {
  it("projects all definitions in canonical order with closed object schemas", () => {
    expect(BROWSER_TOOL_CATALOGUE.map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
    for (const tool of BROWSER_TOOL_CATALOGUE) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toBeTruthy();
      expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"(?:examples|title)":/u);
    }
  });

  it("preserves parameter names, referenced definitions, descriptions and required fields", () => {
    const input = Schema.Struct({
      title: Schema.String.annotate({ identifier: "title", description: "Visible title text" }),
      examples: Schema.Array(Schema.String),
    });
    const definition = { ...BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_open, input, output: input };
    const [projected] = projectBrowserToolDefinitions([definition]);
    expect(projected?.inputSchema).toMatchObject({
      properties: { title: { $ref: "#/$defs/title" }, examples: { type: "array" } },
      required: ["title", "examples"],
      $defs: { title: { type: "string", description: "Visible title text" } },
      additionalProperties: false,
    });
  });

  it("keeps const/enum payloads and object closure scoped to their original schemas", () => {
    const literal = { title: "A", examples: ["B"] };
    const schema = {
      type: "object",
      properties: {
        choice: { enum: [literal], description: "Literal payload" },
        fixed: { const: literal },
        nested: {
          additionalProperties: false,
          allOf: [{ type: "object", properties: { value: { type: "string" } } }],
        },
      },
      required: ["choice", "fixed"],
    };
    expect(compactToolInputSchema(schema)).toEqual(schema);
  });

  it("keeps operational annotations and agent guidance canonical", () => {
    expect(BROWSER_TOOL_DEFINITIONS.map(({ annotations }) => annotations)).toEqual([
      READ_ONLY_LOCAL,
      READ_ONLY_LOCAL,
      MUTATING_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      IDEMPOTENT_LOCAL,
      READ_ONLY_OPEN_WORLD,
      READ_ONLY_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      READ_ONLY_OPEN_WORLD,
      READ_ONLY_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      MUTATING_OPEN_WORLD,
      READ_ONLY_OPEN_WORLD,
      DESTRUCTIVE_OPEN_WORLD,
      DESTRUCTIVE_LOCAL,
    ]);
    for (const tool of BROWSER_TOOL_DEFINITIONS) {
      expect(utf8ByteLength(tool.description)).toBeGreaterThan(120);
      expect(utf8ByteLength(tool.description)).toBeLessThanOrEqual(2_048);
    }
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_click.description).toContain(
      "humanActionRequired",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_open.description).toContain(
      "when no assigned tab exists",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_navigate.description).toContain(
      "use browser_open first",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_snapshot.description).toContain(
      "after navigation or human interaction",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_wait.description).toContain(
      "concrete condition",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_logs.description).toContain(
      "diagnose visible-page behavior",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_screenshot.description).toContain(
      "only when pixels matter",
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_upload.description).toContain(
      "workspace-relative",
    );
    for (const tool of BROWSER_TOOL_DEFINITIONS.slice(2)) {
      expect(tool.description).toContain("BrowserInterruptedByHuman");
      expect(tool.description).toContain("turn stop/abort");
      expect(tool.description).toContain("answer once the outcome is observed");
      if (!tool.annotations.readOnlyHint) {
        expect(tool.description).toContain("BrowserDownloadApprovalRequired");
      }
    }
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_navigate.description).toContain("annotationId");
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_wait.description).toContain('"kind":"text"');
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_wait.description).toContain('"timeMs":500');
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_type.description).toContain(
      '"target":{"ref":"e3","snapshotId"',
    );
    expect(BROWSER_TOOL_DEFINITIONS_BY_NAME.browser_press.description).toContain(
      '"keys":["Enter"]',
    );
  });

  it("serializes JSON stably regardless of object key insertion order", () => {
    expect(stableJsonStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(
      stableJsonStringify({ a: { x: 3, y: 2 }, z: 1 }),
    );
  });

  it("keeps the provider-facing tool catalogue below its context budget", () => {
    const providerCatalogue = BROWSER_TOOL_CATALOGUE.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
    expect(JSON.stringify(providerCatalogue).length).toBeLessThanOrEqual(65_000);
  });

  it("rejects undefined and non-finite JSON values", () => {
    expect(() => stableJsonStringify({ value: undefined })).toThrow();
    expect(() => stableJsonStringify({ value: Number.NaN })).toThrow();
  });
});
