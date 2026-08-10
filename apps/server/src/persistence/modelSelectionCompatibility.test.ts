// FILE: modelSelectionCompatibility.test.ts
// Purpose: Protects provider inference and option normalization for persisted model selections.
// Layer: Persistence compatibility tests
// Depends on: modelSelectionCompatibility.

import { DEFAULT_PROVIDER_PROFILE_ID, ModelSelection } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Schema } from "effect";

import { normalizePersistedModelSelection } from "./modelSelectionCompatibility.ts";

it("preserves canonical Pi model selections", () => {
  assert.deepEqual(normalizePersistedModelSelection({ provider: "pi", model: "openai/gpt-5.5" }), {
    provider: "pi",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
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
      profileId: DEFAULT_PROVIDER_PROFILE_ID,
      model: "openai/gpt-5.5",
    },
  );
});

it("infers Droid only for Factory-exclusive provider-less model slugs", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "minimax-m3" }), {
    provider: "droid",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "minimax-m3",
  });
});

it("does not steal ambiguous provider-less Claude slugs from Claude Agent", () => {
  assert.deepEqual(normalizePersistedModelSelection({ model: "claude-opus-4-8" }), {
    provider: "claudeAgent",
    profileId: DEFAULT_PROVIDER_PROFILE_ID,
    model: "claude-opus-4-8",
  });
});

it("preserves explicit provider profile routing", () => {
  assert.deepEqual(
    normalizePersistedModelSelection({
      provider: "codex",
      profileId: "work",
      model: "gpt-5.6-codex",
    }),
    {
      provider: "codex",
      profileId: "work",
      model: "gpt-5.6-codex",
    },
  );
});

it("does not replace an invalid explicit profile with the default", () => {
  const normalized = normalizePersistedModelSelection({
    provider: "codex",
    profileId: "../work",
    model: "gpt-5.6-codex",
  });

  assert.equal(Schema.decodeUnknownExit(ModelSelection)(normalized)._tag, "Failure");
});
