// FILE: voiceTranscription.ts
// Purpose: Pure routing helpers for the configurable voice-to-text backend.
// Layer: Shared settings/runtime helper
// The coding-agent harness is not the STT provider; Groq can run while Codex,
// Claude, or any other agent is selected.

import type { VoiceTranscriptionProviderKind } from "@synara/contracts";

export type ResolvedVoiceTranscriptionBackend =
  | { readonly kind: "groq"; readonly apiKey: string }
  | { readonly kind: "chatgpt" }
  | { readonly kind: "missing-groq-key" };

export function isIndependentVoiceTranscriptionReady(input: {
  readonly provider: VoiceTranscriptionProviderKind;
  readonly groqApiKeyConfigured: boolean;
}): boolean {
  return input.provider !== "chatgpt" && input.groqApiKeyConfigured;
}

export function resolveVoiceTranscriptionBackend(input: {
  readonly provider: VoiceTranscriptionProviderKind;
  readonly groqApiKey: string | null;
}): ResolvedVoiceTranscriptionBackend {
  if (input.provider === "chatgpt") {
    return { kind: "chatgpt" };
  }
  if (input.groqApiKey) {
    return { kind: "groq", apiKey: input.groqApiKey };
  }
  if (input.provider === "groq") {
    return { kind: "missing-groq-key" };
  }
  return { kind: "chatgpt" };
}
