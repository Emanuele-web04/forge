// FILE: modelSelectionCompatibility.test.ts
// Purpose: Protects provider inference and option normalization for persisted model selections.
// Layer: Persistence compatibility tests
// Depends on: modelSelectionCompatibility.

import { assert, it } from "@effect/vitest";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves canonical Pi model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "pi", model: "openai/gpt-5.5" }), {
    provider: "pi",
    model: "openai/gpt-5.5",
  });
});

it("migrates combined Antigravity model and effort labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "antigravity",
      model: "Gemini 3.5 Flash (High)",
    }),
    {
      provider: "antigravity",
      model: "Gemini 3.5 Flash",
      options: { reasoningEffort: "high" },
    },
  );
});

it("infers Antigravity from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Antigravity CLI",
      model: "Claude Sonnet 4.6 (Thinking)",
    }),
    {
      provider: "antigravity",
      model: "Claude Sonnet 4.6",
      options: { reasoningEffort: "thinking" },
    },
  );
});

it("prefers an explicit Antigravity instance over a model vendor in its label", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Antigravity Claude runtime",
      model: "Claude Sonnet 4.6 (Thinking)",
    }),
    {
      provider: "antigravity",
      model: "Claude Sonnet 4.6",
      options: { reasoningEffort: "thinking" },
    },
  );
});

it("migrates known Gemini models without discarding the saved selection", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "gemini",
      model: "gemini-3.1-pro-preview",
    }),
    {
      provider: "antigravity",
      model: "Gemini 3.1 Pro",
    },
  );
});

it("preserves unknown Gemini models as custom Antigravity selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "gemini",
      model: "gemini-custom-preview",
    }),
    {
      provider: "antigravity",
      model: "gemini-custom-preview",
    },
  );
});

it("infers Pi from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "local-pi-runtime-instance",
      model: "openai/gpt-5.5",
    }),
    {
      provider: "pi",
      model: "openai/gpt-5.5",
    },
  );
});

it("preserves canonical Devin model selections", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "devin",
      model: "swe-1-7",
      options: { reasoningEffort: "high" },
    }),
    {
      provider: "devin",
      model: "swe-1-7",
      options: { reasoningEffort: "high" },
    },
  );
});

it("infers Devin from persisted instance labels", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      instanceId: "Devin CLI",
      model: "adaptive",
    }),
    {
      provider: "devin",
      model: "adaptive",
    },
  );
});

it("infers Droid only for Factory-exclusive provider-less model slugs", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "minimax-m3" }), {
    provider: "droid",
    model: "minimax-m3",
  });
});

it("does not steal ambiguous provider-less Claude slugs from Claude Agent", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "claude-opus-4-8" }), {
    provider: "claudeAgent",
    model: "claude-opus-4-8",
  });
});

it("preserves canonical Devin model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "devin", model: "devin-core" }), {
    provider: "devin",
    model: "devin-core",
  });
});

it("infers Devin from provider-less model slugs containing devin", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "devin-core" }), {
    provider: "devin",
    model: "devin-core",
  });
});
