import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  MIND_MEMORY_TEXT_MAX_CHARS,
  MIND_RECALL_QUERY_MAX_CHARS,
  MIND_RECALL_REQUEST_MAX_ITEMS,
  MindMemory,
  MindRecallInput,
  MindRememberInput,
} from "./mind";

const decodes = <S extends Schema.Top & { readonly DecodingServices: never }>(
  schema: S,
  input: unknown,
) => Schema.is(schema)(input);
const memory = {
  memoryId: "memory-1",
  projectId: "project-1",
  text: "Use SQLite for durable memory.",
  type: "decision",
  weight: 0.7,
  accessCount: 2,
  pinned: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  lastAccessedAt: "2026-09-01T00:00:00.000Z",
  provenance: { kind: "agent", threadId: "thread-1", provider: "codex" },
};

describe("Mind contracts", () => {
  it("encodes memory type, provenance, and bounded weight", () => {
    expect(decodes(MindMemory, memory)).toBe(true);
    expect(decodes(MindMemory, { ...memory, type: "unknown" })).toBe(false);
    expect(decodes(MindMemory, { ...memory, weight: 1.01 })).toBe(false);
    expect(decodes(MindMemory, { ...memory, sourceThreadId: null, sourceProvider: null })).toBe(
      true,
    );
  });

  it("bounds remember text and requires a legal memory type", () => {
    expect(
      decodes(MindRememberInput, {
        text: "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS),
        type: "semantic",
      }),
    ).toBe(true);
    expect(
      decodes(MindRememberInput, {
        text: "x".repeat(MIND_MEMORY_TEXT_MAX_CHARS + 1),
        type: "semantic",
      }),
    ).toBe(false);
    expect(decodes(MindRememberInput, { text: "fact", type: "note" })).toBe(false);
  });

  it("bounds recall query and requested items", () => {
    expect(
      decodes(MindRecallInput, {
        query: "x".repeat(MIND_RECALL_QUERY_MAX_CHARS),
        limit: MIND_RECALL_REQUEST_MAX_ITEMS,
      }),
    ).toBe(true);
    expect(decodes(MindRecallInput, { query: "x".repeat(MIND_RECALL_QUERY_MAX_CHARS + 1) })).toBe(
      false,
    );
    expect(decodes(MindRecallInput, { limit: MIND_RECALL_REQUEST_MAX_ITEMS + 1 })).toBe(false);
    expect(decodes(MindRecallInput, { limit: 0 })).toBe(false);
  });
});
