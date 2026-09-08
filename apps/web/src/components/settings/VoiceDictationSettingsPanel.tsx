// FILE: VoiceDictationSettingsPanel.tsx
// Purpose: Configure the speech-to-text backend independently of the coding agent.
// Layer: Settings UI components

import {
  DEFAULT_GROQ_VOICE_TRANSCRIPTION_MODEL,
  DEFAULT_VOICE_TRANSCRIPTION_PROVIDER,
  GROQ_VOICE_TRANSCRIPTION_MODELS,
  type GroqVoiceTranscriptionModel,
  type VoiceTranscriptionProviderKind,
} from "@synara/contracts";

import type { AppSettingsBinding } from "~/appSettings";
import { SelectItem } from "~/components/ui/select";
import { DebouncedSettingTextInput } from "./DebouncedSettingTextInput";
import {
  SettingResetButton,
  SettingsSegmentedControl,
  SettingsSelectControl,
} from "./SettingControls";
import { SettingsRow, SettingsSection } from "./SettingsPanelPrimitives";

const VOICE_PROVIDER_OPTIONS: ReadonlyArray<{
  value: VoiceTranscriptionProviderKind;
  label: string;
}> = [
  { value: "auto", label: "Auto" },
  { value: "groq", label: "Groq" },
  { value: "chatgpt", label: "ChatGPT" },
];

const GROQ_VOICE_MODEL_LABELS: Record<GroqVoiceTranscriptionModel, string> = {
  "whisper-large-v3-turbo": "Turbo",
  "whisper-large-v3": "Large v3",
  "distil-whisper-large-v3-en": "Distil English",
};

const VOICE_PROVIDER_DESCRIPTIONS: Record<VoiceTranscriptionProviderKind, string> = {
  auto: "Use Groq when an API key is available; otherwise ChatGPT via a Codex login. Independent of the coding agent in the current chat.",
  groq: "Send dictation to Groq Whisper. Works with any coding agent once an API key is set.",
  chatgpt: "Use ChatGPT transcription through a Codex ChatGPT session.",
};

export function VoiceDictationSettingsPanel({
  settings,
  defaults,
  updateSettings,
}: AppSettingsBinding) {
  const showGroqFields = settings.voiceTranscriptionProvider !== "chatgpt";

  return (
    <SettingsSection title="Voice dictation">
      <SettingsRow
        title="Transcription provider"
        description={VOICE_PROVIDER_DESCRIPTIONS[settings.voiceTranscriptionProvider]}
        resetAction={
          settings.voiceTranscriptionProvider !== defaults.voiceTranscriptionProvider ? (
            <SettingResetButton
              label="transcription provider"
              onClick={() =>
                updateSettings({
                  voiceTranscriptionProvider: DEFAULT_VOICE_TRANSCRIPTION_PROVIDER,
                })
              }
            />
          ) : null
        }
        control={
          <SettingsSegmentedControl
            value={settings.voiceTranscriptionProvider}
            onValueChange={(value) => updateSettings({ voiceTranscriptionProvider: value })}
            ariaLabel="Voice transcription provider"
            options={VOICE_PROVIDER_OPTIONS}
          />
        }
      />

      {showGroqFields ? (
        <>
          <SettingsRow
            title="Groq model"
            description="Whisper model used for Groq speech-to-text."
            resetAction={
              settings.voiceTranscriptionGroqModel !== defaults.voiceTranscriptionGroqModel ? (
                <SettingResetButton
                  label="Groq voice model"
                  onClick={() =>
                    updateSettings({
                      voiceTranscriptionGroqModel: DEFAULT_GROQ_VOICE_TRANSCRIPTION_MODEL,
                    })
                  }
                />
              ) : null
            }
            control={
              <SettingsSelectControl
                value={settings.voiceTranscriptionGroqModel}
                onValueChange={(value) => {
                  if (!isGroqVoiceModel(value)) return;
                  updateSettings({ voiceTranscriptionGroqModel: value });
                }}
                ariaLabel="Groq voice transcription model"
                valueContent={GROQ_VOICE_MODEL_LABELS[settings.voiceTranscriptionGroqModel]}
              >
                {GROQ_VOICE_TRANSCRIPTION_MODELS.map((model) => (
                  <SelectItem hideIndicator key={model} value={model}>
                    {GROQ_VOICE_MODEL_LABELS[model]}
                  </SelectItem>
                ))}
              </SettingsSelectControl>
            }
          />

          <SettingsRow
            title="Groq API key"
            description="Stored on the server. You can also set GROQ_API_KEY in the environment. Get a key from console.groq.com."
            control={
              <DebouncedSettingTextInput
                size="sm"
                variant="soft"
                className="w-full sm:w-56"
                value=""
                onCommit={(nextValue) =>
                  updateSettings({ voiceTranscriptionGroqApiKey: nextValue })
                }
                placeholder={
                  settings.voiceTranscriptionGroqApiKeyConfigured
                    ? "Configured — enter a replacement or leave blank"
                    : "gsk_..."
                }
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                aria-label="Groq API key"
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

function isGroqVoiceModel(value: string): value is GroqVoiceTranscriptionModel {
  return (GROQ_VOICE_TRANSCRIPTION_MODELS as readonly string[]).includes(value);
}
