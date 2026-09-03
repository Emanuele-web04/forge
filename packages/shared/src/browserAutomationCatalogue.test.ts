import { BROWSER_TOOL_NAMES, utf8ByteLength } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  BROWSER_TOOL_CATALOGUE,
  BROWSER_TOOL_CATALOG_DIGEST_INPUT,
  BROWSER_TOOL_DEFINITIONS,
  BROWSER_TOOL_DEFINITIONS_BY_NAME,
  DESTRUCTIVE_LOCAL,
  DESTRUCTIVE_OPEN_WORLD,
  IDEMPOTENT_LOCAL,
  MUTATING_OPEN_WORLD,
  READ_ONLY_LOCAL,
  READ_ONLY_OPEN_WORLD,
  stableJsonStringify,
} from "./browserAutomationCatalogue";

describe("browser automation catalogue projection", () => {
  it("projects all definitions in canonical order with closed object schemas", () => {
    expect(BROWSER_TOOL_CATALOGUE.map(({ name }) => name)).toEqual(BROWSER_TOOL_NAMES);
    for (const tool of BROWSER_TOOL_CATALOGUE) {
      expect(tool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect(tool.outputSchema).toBeTruthy();
    }
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

  it("serializes digest input stably regardless of object key insertion order", () => {
    expect(stableJsonStringify({ z: 1, a: { y: 2, x: 3 } })).toBe(
      stableJsonStringify({ a: { x: 3, y: 2 }, z: 1 }),
    );
    expect(JSON.parse(stableJsonStringify(BROWSER_TOOL_CATALOG_DIGEST_INPUT))).toEqual(
      BROWSER_TOOL_CATALOG_DIGEST_INPUT,
    );
  });

  it("rejects undefined and non-finite JSON values", () => {
    expect(() => stableJsonStringify({ value: undefined })).toThrow();
    expect(() => stableJsonStringify({ value: Number.NaN })).toThrow();
  });
});
