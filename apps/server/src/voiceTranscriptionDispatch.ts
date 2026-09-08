// FILE: voiceTranscriptionDispatch.ts
// Purpose: Routes voice prewarm/transcribe to the configured STT backend.
// Layer: Server voice transcription
// Groq is independent of the coding-agent harness; ChatGPT still uses Codex.

import type {
  ServerVoicePrewarmInput,
  ServerVoicePrewarmResult,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@synara/contracts";
import { prewarmGroqVoiceTranscriptionConnection } from "@synara/shared/groqVoiceTranscription";
import { resolveVoiceTranscriptionBackend } from "@synara/shared/voiceTranscription";
import { Effect } from "effect";

import { getEnabledProviderAdapter } from "./provider/enabledProviderAdapter";
import type { ProviderAdapterRegistryShape } from "./provider/Services/ProviderAdapterRegistry";
import type { ServerSettingsShape } from "./serverSettings";
import { transcribeVoiceWithGroq } from "./voiceTranscription.ts";

export const MISSING_GROQ_VOICE_KEY_MESSAGE =
  "Add a Groq API key in Settings > General, or set GROQ_API_KEY.";

export function transcribeConfiguredVoice(
  input: ServerVoiceTranscriptionInput,
  serverSettings: ServerSettingsShape,
  providerAdapterRegistry: ProviderAdapterRegistryShape,
) {
  return Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const groqApiKey = yield* serverSettings.getVoiceTranscriptionGroqApiKey;
    const backend = resolveVoiceTranscriptionBackend({
      provider: settings.voiceTranscription.provider,
      groqApiKey,
    });
    if (backend.kind === "missing-groq-key") {
      return yield* Effect.fail(new Error(MISSING_GROQ_VOICE_KEY_MESSAGE));
    }
    if (backend.kind === "groq") {
      return yield* Effect.tryPromise({
        try: () =>
          transcribeVoiceWithGroq({
            request: input,
            apiKey: backend.apiKey,
            model: settings.voiceTranscription.groqModel,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      });
    }
    return yield* transcribeChatGptVoice(input, serverSettings, providerAdapterRegistry);
  });
}

export function prewarmConfiguredVoice(
  input: ServerVoicePrewarmInput,
  serverSettings: ServerSettingsShape,
  providerAdapterRegistry: ProviderAdapterRegistryShape,
) {
  return Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const groqApiKey = yield* serverSettings.getVoiceTranscriptionGroqApiKey;
    const backend = resolveVoiceTranscriptionBackend({
      provider: settings.voiceTranscription.provider,
      groqApiKey,
    });
    if (backend.kind === "missing-groq-key") {
      return yield* Effect.fail(new Error(MISSING_GROQ_VOICE_KEY_MESSAGE));
    }
    if (backend.kind === "groq") {
      yield* Effect.ignore(Effect.tryPromise(() => prewarmGroqVoiceTranscriptionConnection()));
      return { ready: true } satisfies ServerVoicePrewarmResult;
    }
    const adapter = yield* getEnabledProviderAdapter(
      input.provider,
      serverSettings,
      providerAdapterRegistry,
    );
    if (!adapter.prewarmVoice) {
      return yield* Effect.fail(
        new Error(`Voice transcription is unavailable for provider '${input.provider}'.`),
      );
    }
    return yield* adapter.prewarmVoice(input);
  });
}

function transcribeChatGptVoice(
  input: ServerVoiceTranscriptionInput,
  serverSettings: ServerSettingsShape,
  providerAdapterRegistry: ProviderAdapterRegistryShape,
): Effect.Effect<ServerVoiceTranscriptionResult, unknown> {
  return getEnabledProviderAdapter(input.provider, serverSettings, providerAdapterRegistry).pipe(
    Effect.flatMap((adapter) =>
      adapter.transcribeVoice
        ? adapter.transcribeVoice(input)
        : Effect.fail(
            new Error(`Voice transcription is unavailable for provider '${input.provider}'.`),
          ),
    ),
  );
}
