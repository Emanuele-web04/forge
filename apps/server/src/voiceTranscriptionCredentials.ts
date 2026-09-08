// FILE: voiceTranscriptionCredentials.ts
// Purpose: Owns the server-only Groq speech-to-text API key.
// Layer: Server voice-transcription security boundary

import { Effect, Layer, ServiceMap } from "effect";

import { readGroqApiKeyFromEnv } from "@synara/shared/groqVoiceTranscription";

import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore";
import { ServerSecretStore, type SecretStoreError } from "./auth/Services/ServerSecretStore";

const GROQ_API_KEY_SECRET = "voice-transcription-groq-api-key";

export interface VoiceTranscriptionCredentialsShape {
  readonly getGroqApiKey: () => Effect.Effect<string | null, SecretStoreError>;
  readonly replaceGroqApiKey: (apiKey: string | null) => Effect.Effect<void, SecretStoreError>;
  readonly isGroqApiKeyConfigured: () => Effect.Effect<boolean, SecretStoreError>;
}

export class VoiceTranscriptionCredentials extends ServiceMap.Service<
  VoiceTranscriptionCredentials,
  VoiceTranscriptionCredentialsShape
>()("synara/voiceTranscription/VoiceTranscriptionCredentials") {}

const makeVoiceTranscriptionCredentials = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });

  const getStoredGroqApiKey: VoiceTranscriptionCredentialsShape["getGroqApiKey"] = () =>
    secrets.get(GROQ_API_KEY_SECRET).pipe(
      Effect.map((value) => {
        if (!value || value.byteLength === 0) return null;
        const apiKey = decoder.decode(value);
        return apiKey.length > 0 ? apiKey : null;
      }),
    );

  const getGroqApiKey: VoiceTranscriptionCredentialsShape["getGroqApiKey"] = () =>
    getStoredGroqApiKey().pipe(Effect.map((stored) => stored ?? readGroqApiKeyFromEnv()));

  const replaceGroqApiKey: VoiceTranscriptionCredentialsShape["replaceGroqApiKey"] = (apiKey) => {
    const normalized = apiKey?.trim() ?? "";
    return normalized.length > 0
      ? secrets.set(GROQ_API_KEY_SECRET, encoder.encode(normalized))
      : secrets.remove(GROQ_API_KEY_SECRET);
  };

  const isGroqApiKeyConfigured: VoiceTranscriptionCredentialsShape["isGroqApiKeyConfigured"] = () =>
    getGroqApiKey().pipe(Effect.map((apiKey) => apiKey !== null));

  return {
    getGroqApiKey,
    replaceGroqApiKey,
    isGroqApiKeyConfigured,
  } satisfies VoiceTranscriptionCredentialsShape;
});

export const VoiceTranscriptionCredentialsLive = Layer.effect(
  VoiceTranscriptionCredentials,
  makeVoiceTranscriptionCredentials,
).pipe(Layer.provide(ServerSecretStoreLive));
