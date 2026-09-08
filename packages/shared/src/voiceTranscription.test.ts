// FILE: voiceTranscription.test.ts
// Purpose: Locks independent STT routing so Groq does not depend on the coding harness.

import { describe, expect, it } from "vitest";

import {
  isIndependentVoiceTranscriptionReady,
  resolveVoiceTranscriptionBackend,
} from "./voiceTranscription";

describe("isIndependentVoiceTranscriptionReady", () => {
  it("is ready for auto and groq only when a Groq key is configured", () => {
    expect(
      isIndependentVoiceTranscriptionReady({ provider: "auto", groqApiKeyConfigured: true }),
    ).toBe(true);
    expect(
      isIndependentVoiceTranscriptionReady({ provider: "groq", groqApiKeyConfigured: true }),
    ).toBe(true);
    expect(
      isIndependentVoiceTranscriptionReady({ provider: "auto", groqApiKeyConfigured: false }),
    ).toBe(false);
    expect(
      isIndependentVoiceTranscriptionReady({
        provider: "chatgpt",
        groqApiKeyConfigured: true,
      }),
    ).toBe(false);
  });
});

describe("resolveVoiceTranscriptionBackend", () => {
  it("prefers Groq in auto mode when a key is present", () => {
    expect(resolveVoiceTranscriptionBackend({ provider: "auto", groqApiKey: "gsk_test" })).toEqual({
      kind: "groq",
      apiKey: "gsk_test",
    });
  });

  it("falls back to ChatGPT in auto mode without a Groq key", () => {
    expect(resolveVoiceTranscriptionBackend({ provider: "auto", groqApiKey: null })).toEqual({
      kind: "chatgpt",
    });
  });

  it("requires a Groq key when Groq is selected explicitly", () => {
    expect(resolveVoiceTranscriptionBackend({ provider: "groq", groqApiKey: null })).toEqual({
      kind: "missing-groq-key",
    });
  });

  it("keeps ChatGPT when that provider is selected even if a Groq key exists", () => {
    expect(
      resolveVoiceTranscriptionBackend({ provider: "chatgpt", groqApiKey: "gsk_test" }),
    ).toEqual({ kind: "chatgpt" });
  });
});
